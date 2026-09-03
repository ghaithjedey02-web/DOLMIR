import { z } from 'zod';

import { type Evidence, EvidenceKind, EvidenceSchema } from '../../../kernel/epistemic.js';
import { type ValidationError, validationErrorFromZod } from '../../../kernel/errors.js';
import { type DocumentId, DocumentIdSchema } from '../../../kernel/ids.js';
import { err, ok, type Result } from '../../../kernel/result.js';

/**
 * Extracted text, in parts (part 0 for a single body, one part per page for
 * paginated formats). Offsets are code-unit offsets into `text`, so a span
 * cited as evidence can be re-read exactly — the anti-hallucination check of
 * the UNDERSTAND stage: a quote that is not in the document is not evidence.
 */
export const DocumentTextSchema = z
  .object({
    documentId: DocumentIdSchema,
    part: z.number().int().min(0),
    text: z.string(),
    charCount: z.number().int().min(0),
    /** Which extractor produced it (`plain`, `html`, `pdf`…). */
    extractor: z.string().trim().min(1).max(50),
    extractedAt: z.date(),
  })
  .strict();
export type DocumentText = z.infer<typeof DocumentTextSchema>;

export const DocumentSpanSchema = z
  .object({
    part: z.number().int().min(0),
    start: z.number().int().min(0),
    end: z.number().int().min(1),
  })
  .strict()
  .refine((span) => span.end > span.start, { message: 'end must be greater than start' });
export type DocumentSpan = z.infer<typeof DocumentSpanSchema>;

export function documentSourceRef(documentId: DocumentId): string {
  return `document:${documentId}`;
}

const normaliseWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * Finds a verbatim quote in the document text. Whitespace differences are
 * tolerated (models collapse line breaks); anything else must match exactly.
 * Returns the first occurrence, or `undefined` when the quote is not there.
 */
export function locateQuote(
  texts: readonly DocumentText[],
  quote: string,
): (DocumentSpan & { readonly content: string }) | undefined {
  const needle = quote.trim();
  if (needle.length === 0) return undefined;
  for (const part of [...texts].sort((a, b) => a.part - b.part)) {
    const exact = part.text.indexOf(needle);
    if (exact >= 0) {
      return { part: part.part, start: exact, end: exact + needle.length, content: needle };
    }
    const found = locateNormalised(part.text, needle);
    if (found !== undefined) return { part: part.part, ...found };
  }
  return undefined;
}

function locateNormalised(
  text: string,
  needle: string,
): { start: number; end: number; content: string } | undefined {
  // Build a whitespace-insensitive regex from the needle: each whitespace run matches any run.
  const pieces = needle
    .split(/\s+/)
    .filter((piece) => piece.length > 0)
    .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (pieces.length === 0) return undefined;
  const match = new RegExp(pieces.join('\\s+')).exec(text);
  if (match === null) return undefined;
  return { start: match.index, end: match.index + match[0].length, content: match[0] };
}

/** Builds DOCUMENT_SPAN evidence for a quote, or fails when the quote is not in the text. */
export function evidenceForQuote(
  documentId: DocumentId,
  texts: readonly DocumentText[],
  quote: string,
): Result<Evidence, ValidationError> {
  const span = locateQuote(texts, quote);
  if (span === undefined) {
    return err(
      validationErrorFromZod(
        new z.ZodError([
          {
            code: 'custom',
            path: ['quote'],
            message: 'The quoted text does not occur in the document.',
            input: quote,
          },
        ]),
        'QUOTE_NOT_IN_DOCUMENT',
        'The quoted text does not occur in the document.',
      ),
    );
  }
  return ok(
    EvidenceSchema.parse({
      kind: EvidenceKind.DOCUMENT_SPAN,
      sourceRef: documentSourceRef(documentId),
      content: span.content,
      locator: { part: span.part, start: span.start, end: span.end },
    }),
  );
}

/**
 * Re-reads a DOCUMENT_SPAN evidence against the texts. True only when the
 * locator points at the cited content (whitespace-normalised comparison).
 */
export function verifyDocumentSpan(texts: readonly DocumentText[], evidence: Evidence): boolean {
  if (evidence.kind !== EvidenceKind.DOCUMENT_SPAN) return false;
  const locator = DocumentSpanSchema.safeParse(evidence.locator);
  if (!locator.success) return false;
  const part = texts.find((candidate) => candidate.part === locator.data.part);
  if (part === undefined) return false;
  const slice = part.text.slice(locator.data.start, locator.data.end);
  return normaliseWhitespace(slice) === normaliseWhitespace(evidence.content);
}
