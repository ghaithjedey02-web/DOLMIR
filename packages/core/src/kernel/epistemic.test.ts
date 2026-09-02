import { describe, expect, it } from 'vitest';

import { EpistemicStatus, EvidenceKind, UncertaintyKind, claim, uncertainty } from './epistemic.js';

const computation = {
  kind: EvidenceKind.COMPUTATION,
  sourceRef: 'sum_line_quantities(RFQ-2026-0521)',
  content: '2000',
} as const;

const span = {
  kind: EvidenceKind.DOCUMENT_SPAN,
  sourceRef: 'doc:DOC-EMAIL-521#chars=40-63',
  content: '2.000 staffe SL-4410',
  locator: { start: 40, end: 63 },
} as const;

describe('Claim grounding discipline', () => {
  it('constructs a FACT grounded in a computation', () => {
    const result = claim({
      statement: 'The request totals 2000 pieces.',
      status: EpistemicStatus.FACT,
      evidence: [computation],
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a FACT without computation, citation or record evidence', () => {
    const ungrounded = claim({
      statement: 'The customer always pays late.',
      status: EpistemicStatus.FACT,
    });
    expect(ungrounded.ok).toBe(false);
    if (ungrounded.ok) return;
    expect(ungrounded.error.code).toBe('INVALID_CLAIM');
    expect(JSON.stringify(ungrounded.error.details)).toContain('downgrade it to ASSUMPTION');

    const spanOnly = claim({
      statement: 'The quantity is 2000.',
      status: EpistemicStatus.FACT,
      evidence: [span],
    });
    expect(spanOnly.ok).toBe(false);
  });

  it('requires an OBSERVATION to point at the data it read', () => {
    expect(
      claim({
        statement: 'The email asks for 2000 pieces.',
        status: EpistemicStatus.OBSERVATION,
        evidence: [span],
      }).ok,
    ).toBe(true);
    expect(
      claim({
        statement: 'The email asks for 2000 pieces.',
        status: EpistemicStatus.OBSERVATION,
        evidence: [],
      }).ok,
    ).toBe(false);
  });

  it('allows ASSUMPTION and HYPOTHESIS without evidence — the label is the point', () => {
    expect(
      claim({ statement: 'Probably a repeat order.', status: EpistemicStatus.ASSUMPTION }).ok,
    ).toBe(true);
    expect(
      claim({ statement: 'The customer will accept.', status: EpistemicStatus.HYPOTHESIS }).ok,
    ).toBe(true);
  });

  it('rejects untraceable evidence and empty statements', () => {
    const untraceable = claim({
      statement: 'x',
      status: EpistemicStatus.FACT,
      evidence: [{ kind: EvidenceKind.COMPUTATION, sourceRef: '  ', content: '1' }],
    });
    expect(untraceable.ok).toBe(false);
    expect(claim({ statement: '   ', status: EpistemicStatus.ASSUMPTION }).ok).toBe(false);
  });
});

describe('Uncertainty', () => {
  it('missing information must name its resolution; stochastic uncertainty cannot', () => {
    expect(
      uncertainty({
        kind: UncertaintyKind.MISSING_INFORMATION,
        description: 'Material grade not stated.',
        resolution: 'Ask the customer or read the attached drawing.',
      }).ok,
    ).toBe(true);
    expect(
      uncertainty({
        kind: UncertaintyKind.MISSING_INFORMATION,
        description: 'Material grade not stated.',
      }).ok,
    ).toBe(false);
    expect(
      uncertainty({
        kind: UncertaintyKind.STOCHASTIC,
        description: 'Whether the customer awards the job.',
      }).ok,
    ).toBe(true);
    expect(
      uncertainty({
        kind: UncertaintyKind.STOCHASTIC,
        description: 'Whether the customer awards the job.',
        resolution: 'Wait.',
      }).ok,
    ).toBe(false);
  });
});
