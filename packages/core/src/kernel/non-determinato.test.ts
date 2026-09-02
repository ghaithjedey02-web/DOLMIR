import { describe, expect, it } from 'vitest';

import { EvidenceKind } from './epistemic.js';
import {
  type Determination,
  determined,
  isDetermined,
  isNonDeterminato,
  nonDeterminato,
} from './non-determinato.js';

const emailSpan = {
  kind: EvidenceKind.DOCUMENT_SPAN,
  sourceRef: 'doc:DOC-EMAIL-482#line=1',
  content: '40 pz PF-2205',
} as const;
const pdfSpan = {
  kind: EvidenceKind.DOCUMENT_SPAN,
  sourceRef: 'doc:DOC-PDF-482#page=1',
  content: 'PF-2205 q.tà 60',
} as const;

describe('NON_DETERMINATO', () => {
  it('captures a conflict between two sources and the human decision it requires', () => {
    const result = nonDeterminato({
      subject: 'quantity of PF-2205 on order ORD-10482',
      unknown: ['which quantity the customer actually wants'],
      evidence: [emailSpan, pdfSpan],
      conflicts: [
        {
          description: 'Email body says 40 pieces; the attached PDF says 60.',
          evidence: [emailSpan, pdfSpan],
        },
      ],
      requiredHumanDecision: {
        question: 'Confirm the quantity for PF-2205 with the customer.',
        options: [{ label: '40 (email)' }, { label: '60 (PDF)' }],
        stake: 'Wrong quantity ships or is invoiced.',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('NON_DETERMINATO');
    expect(result.value.conflicts).toHaveLength(1);
    expect(result.value.known).toEqual([]);
    expect(result.value.missingInputs).toEqual([]);
  });

  it('refuses an empty NON_DETERMINATO — a result with nothing missing is determinable', () => {
    const result = nonDeterminato({ subject: 'anything' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_NON_DETERMINATO');
  });

  it('is a first-class alternative to a determined value', () => {
    const yes: Determination<number> = determined(60);
    expect(isDetermined(yes)).toBe(true);
    expect(isNonDeterminato(yes)).toBe(false);

    const no = nonDeterminato({
      subject: 'quantity',
      missingInputs: [
        { name: 'quantity', description: 'No quantity in the request.', resolvableBy: 'HUMAN' },
      ],
    });
    if (!no.ok) throw new Error('expected a NON_DETERMINATO');
    const outcome: Determination<number> = no.value;
    expect(isDetermined(outcome)).toBe(false);
    expect(isNonDeterminato(outcome)).toBe(true);
  });
});
