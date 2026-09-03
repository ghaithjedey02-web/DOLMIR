import { InfrastructureError } from '../../../../kernel/errors.js';
import { err, ok, type Result } from '../../../../kernel/result.js';
import {
  type ExtractedText,
  type TextExtractionInput,
  type TextExtractorPort,
  htmlToText,
} from '../../../documents/index.js';
import type { MimeParserPort } from '../../application/ports.js';

/**
 * Makes an e-mail document readable without changing what it stores. The
 * document holds the raw MIME, so its content hash is the hash of the message
 * as it arrived; this extractor derives the text the AI reads and cites.
 *
 * Two parts, so evidence can say where a quotation came from:
 *   part 0  the subject
 *   part 1  the body, preferring the plain-text alternative over the HTML one
 *
 * The HTML path goes through the same converter the rest of the platform uses,
 * which drops scripts, styles and markup. No link is followed and no remote
 * content is loaded.
 */
export const EMAIL_MEDIA_TYPE = 'message/rfc822';
export const EMAIL_SUBJECT_PART = 0;
export const EMAIL_BODY_PART = 1;

export class EmailTextExtractor implements TextExtractorPort {
  readonly name = 'email';
  private readonly parser: MimeParserPort;

  constructor(parser: MimeParserPort) {
    this.parser = parser;
  }

  supports(contentType: string): boolean {
    return contentType.split(';')[0]?.trim().toLowerCase() === EMAIL_MEDIA_TYPE;
  }

  async extract(input: TextExtractionInput): Promise<Result<ExtractedText[], InfrastructureError>> {
    const parsed = await this.parser.parse(input.body);
    if (!parsed.ok) {
      return err(
        new InfrastructureError('EMAIL_TEXT_EXTRACTION_FAILED', 'The message could not be read.', {
          cause: parsed.error,
        }),
      );
    }
    const message = parsed.value;
    const body = message.text ?? (message.html === null ? null : htmlToText(message.html));
    const parts: ExtractedText[] = [];
    if (message.subject !== null) {
      parts.push({ part: EMAIL_SUBJECT_PART, text: message.subject });
    }
    if (body !== null && body.trim().length > 0) {
      parts.push({ part: EMAIL_BODY_PART, text: body });
    }
    return ok(parts);
  }
}
