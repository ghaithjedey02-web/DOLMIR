import { InfrastructureError } from '../../../../kernel/errors.js';
import { err, ok, type Result } from '../../../../kernel/result.js';
import type {
  ExtractedText,
  TextExtractionInput,
  TextExtractorPort,
} from '../../application/ports.js';

/**
 * Deterministic text extraction for the formats Phase 2 needs from e-mail:
 * plain text and HTML. PDF and office formats arrive as further adapters
 * behind the same port; until then they are reported as `unsupported`, never
 * silently skipped.
 */
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv']);

// Built from code points so no invisible character has to live in the source.
const NUL = String.fromCharCode(0);
const NO_BREAK_SPACE = String.fromCharCode(160);
const NUL_PATTERN = new RegExp(NUL, 'g');
const INLINE_SPACE_PATTERN = new RegExp(`[ ${NO_BREAK_SPACE}]+`, 'g');

const mediaType = (contentType: string): string =>
  contentType.split(';')[0]?.trim().toLowerCase() ?? '';

const charset = (contentType: string): string | undefined => {
  const match = /charset=("?)([\w-]+)\1/i.exec(contentType);
  return match?.[2]?.toLowerCase();
};

function decode(body: Uint8Array, contentType: string): string {
  const label = charset(contentType) ?? 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** CRLF to LF; NUL characters removed (PostgreSQL text cannot hold them). */
function normaliseLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(NUL_PATTERN, '');
}

export class PlainTextExtractor implements TextExtractorPort {
  readonly name = 'plain';

  supports(contentType: string): boolean {
    return TEXT_TYPES.has(mediaType(contentType));
  }

  async extract(input: TextExtractionInput): Promise<Result<ExtractedText[], never>> {
    return ok([{ part: 0, text: normaliseLineBreaks(decode(input.body, input.contentType)) }]);
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  euro: '€',
  agrave: 'à',
  egrave: 'è',
  eacute: 'é',
  igrave: 'ì',
  ograve: 'ò',
  ugrave: 'ù',
};

export function htmlToText(html: string): string {
  const withoutInvisible = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '');
  const withBreaks = withoutInvisible
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|section|article)>/gi, '\n')
    .replace(/<(p|div|tr|li|h[1-6]|blockquote|table|section|article)[^>]*>/gi, '')
    .replace(/<\/td>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  const decoded = withBreaks.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
  return normaliseLineBreaks(decoded)
    .split('\n')
    .map((line) => line.replace(INLINE_SPACE_PATTERN, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export class HtmlTextExtractor implements TextExtractorPort {
  readonly name = 'html';

  supports(contentType: string): boolean {
    return mediaType(contentType) === 'text/html';
  }

  async extract(input: TextExtractionInput): Promise<Result<ExtractedText[], never>> {
    return ok([{ part: 0, text: htmlToText(decode(input.body, input.contentType)) }]);
  }
}

/** Dispatches to the first extractor that supports the content type. */
export class CompositeTextExtractor implements TextExtractorPort {
  readonly name: string;
  private readonly extractors: readonly TextExtractorPort[];

  constructor(extractors: readonly TextExtractorPort[]) {
    this.extractors = extractors;
    this.name = extractors.map((extractor) => extractor.name).join('+');
  }

  supports(contentType: string, filename: string | null): boolean {
    return this.extractors.some((extractor) => extractor.supports(contentType, filename));
  }

  async extract(input: TextExtractionInput): Promise<Result<ExtractedText[], InfrastructureError>> {
    const extractor = this.extractors.find((candidate) =>
      candidate.supports(input.contentType, input.filename),
    );
    if (extractor === undefined) {
      return err(
        new InfrastructureError(
          'TEXT_EXTRACTION_UNSUPPORTED',
          `No extractor supports ${input.contentType}.`,
        ),
      );
    }
    try {
      const result = await extractor.extract(input);
      return result.ok
        ? ok(result.value)
        : err(
            new InfrastructureError('TEXT_EXTRACTION_FAILED', 'Text extraction failed.', {
              cause: result.error,
            }),
          );
    } catch (cause) {
      return err(
        new InfrastructureError('TEXT_EXTRACTION_FAILED', 'Text extraction failed.', { cause }),
      );
    }
  }
}

export function defaultTextExtractor(): TextExtractorPort {
  return new CompositeTextExtractor([new PlainTextExtractor(), new HtmlTextExtractor()]);
}
