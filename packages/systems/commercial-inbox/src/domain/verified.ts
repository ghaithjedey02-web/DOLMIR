import { type DocumentId, type DocumentText, type Evidence, evidenceForQuote } from '@dolmir/core';

/**
 * A business value that survived verification: the parsed value, the verbatim
 * text it came from, and the evidence pointing at where that text is. Nothing
 * else may become a fact in a DOLMIR finding.
 */
export interface VerifiedValue<T> {
  readonly value: T;
  /** The exact text found in the source, which may differ from what the model wrote. */
  readonly quote: string;
  readonly evidence: Evidence;
  /** Which source it was found in, for the reader: `email`, `attachment:righe.csv`. */
  readonly source: string;
}

/** One document a quotation may legitimately come from: the message or one of its attachments. */
export interface EvidenceSource {
  readonly documentId: DocumentId;
  readonly label: string;
  readonly texts: readonly DocumentText[];
}

export interface VerifiedQuote {
  readonly quote: string;
  readonly evidence: Evidence;
  readonly source: string;
}

/**
 * Finds a quotation in the message or its attachments. Whitespace differences
 * are tolerated, because a model reading a wrapped line collapses it; anything
 * else must match exactly. A quotation found nowhere returns `null`, and the
 * value it was supposed to support is dropped rather than believed.
 */
export function verifyQuote(
  sources: readonly EvidenceSource[],
  quote: string,
): VerifiedQuote | null {
  for (const source of sources) {
    const evidence = evidenceForQuote(source.documentId, source.texts, quote);
    if (evidence.ok) {
      return { quote: evidence.value.content, evidence: evidence.value, source: source.label };
    }
  }
  return null;
}

/** Verifies a quotation and parses it, keeping the two steps in that order. */
export function verifyAndParse<T>(
  sources: readonly EvidenceSource[],
  quote: string | null,
  parse: (verified: string) => T | null,
): VerifiedValue<T> | null {
  if (quote === null) return null;
  const verified = verifyQuote(sources, quote);
  if (verified === null) return null;
  const value = parse(verified.quote);
  if (value === null) return null;
  return { value, quote: verified.quote, evidence: verified.evidence, source: verified.source };
}
