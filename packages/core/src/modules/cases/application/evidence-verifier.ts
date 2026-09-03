import type { Evidence } from '../../../kernel/epistemic.js';
import type { TenantScope } from '../../../kernel/scope.js';

/**
 * Checks that cited evidence is real (ADR-0007, ADR-0012). A `DOCUMENT_SPAN`
 * must occur in the stored text of the document it names, at the offsets it
 * claims. This is the platform's backstop against a fabricated citation: an
 * AI System is expected to verify before it proposes, and the case engine
 * refuses to store a draft whose citations do not hold up.
 *
 * Evidence kinds the verifier cannot check — a citation to an outside source,
 * a computation — pass through. They are still constrained by the kernel's
 * grounding discipline, which decides which kinds may support a FACT.
 */
export interface RejectedEvidence {
  readonly evidence: Evidence;
  readonly reason:
    'DOCUMENT_NOT_FOUND' | 'SPAN_NOT_IN_DOCUMENT' | 'MALFORMED_SOURCE_REF' | 'FOREIGN_DOCUMENT';
}

export interface EvidenceVerification {
  readonly checked: number;
  readonly rejected: readonly RejectedEvidence[];
}

export interface EvidenceVerifier {
  verify(scope: TenantScope, evidence: readonly Evidence[]): Promise<EvidenceVerification>;
}
