import { describe, expect, it } from 'vitest';

import { EvidenceKind } from '../../../kernel/epistemic.js';
import { newDocumentId } from '../../../kernel/ids.js';
import {
  type DocumentText,
  evidenceForQuote,
  locateQuote,
  verifyDocumentSpan,
} from './document-text.js';

const documentId = newDocumentId();
const texts: DocumentText[] = [
  {
    documentId,
    part: 0,
    text: 'Buongiorno,\npotete inviarci un preventivo per 250 flange tornite\nin acciaio S355?\nConsegna entro fine mese.',
    charCount: 100,
    extractor: 'plain',
    extractedAt: new Date('2026-09-03T08:00:00.000Z'),
  },
];

describe('document spans', () => {
  it('locates an exact quote and a quote with different whitespace', () => {
    expect(locateQuote(texts, 'preventivo per 250 flange')).toMatchObject({
      part: 0,
      start: 31,
      end: 56,
    });
    const wrapped = locateQuote(texts, 'flange tornite in acciaio S355');
    expect(wrapped?.content).toBe('flange tornite\nin acciaio S355');
    expect(locateQuote(texts, '300 flange')).toBeUndefined();
    expect(locateQuote(texts, '   ')).toBeUndefined();
  });

  it('builds DOCUMENT_SPAN evidence only for quotes that exist', () => {
    const evidence = evidenceForQuote(documentId, texts, 'Consegna entro fine mese');
    expect(evidence.ok).toBe(true);
    if (!evidence.ok) return;
    expect(evidence.value).toMatchObject({
      kind: EvidenceKind.DOCUMENT_SPAN,
      sourceRef: `document:${documentId}`,
      content: 'Consegna entro fine mese',
      locator: { part: 0 },
    });
    expect(verifyDocumentSpan(texts, evidence.value)).toBe(true);

    const invented = evidenceForQuote(documentId, texts, 'sconto del 20%');
    expect(!invented.ok && invented.error.code).toBe('QUOTE_NOT_IN_DOCUMENT');
  });

  it('rejects spans whose locator does not point at the cited content', () => {
    expect(
      verifyDocumentSpan(texts, {
        kind: EvidenceKind.DOCUMENT_SPAN,
        sourceRef: `document:${documentId}`,
        content: 'preventivo',
        locator: { part: 0, start: 0, end: 10 },
      }),
    ).toBe(false);
    expect(
      verifyDocumentSpan(texts, {
        kind: EvidenceKind.OBSERVATION,
        sourceRef: 'x',
        content: 'Buongiorno',
      }),
    ).toBe(false);
    expect(
      verifyDocumentSpan(texts, {
        kind: EvidenceKind.DOCUMENT_SPAN,
        sourceRef: `document:${documentId}`,
        content: 'Buongiorno',
        locator: { part: 3, start: 0, end: 10 },
      }),
    ).toBe(false);
  });
});
