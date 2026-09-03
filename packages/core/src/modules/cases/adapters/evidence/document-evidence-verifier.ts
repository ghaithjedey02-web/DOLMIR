import { EvidenceKind, type Evidence } from '../../../../kernel/epistemic.js';
import { DocumentIdSchema } from '../../../../kernel/ids.js';
import type { TenantScope } from '../../../../kernel/scope.js';
import { type DocumentTextRepository, verifyDocumentSpan } from '../../../documents/index.js';
import type {
  EvidenceVerification,
  EvidenceVerifier,
  RejectedEvidence,
} from '../../application/evidence-verifier.js';

/**
 * Re-reads every `DOCUMENT_SPAN` against the text the platform stored. The
 * read happens inside the caller's tenant scope, so a span naming another
 * tenant's document finds nothing and is rejected rather than verified.
 */
const DOCUMENT_REF = /^document:([0-9a-f-]{36})$/;

export class DocumentEvidenceVerifier implements EvidenceVerifier {
  private readonly texts: DocumentTextRepository;

  constructor(texts: DocumentTextRepository) {
    this.texts = texts;
  }

  async verify(scope: TenantScope, evidence: readonly Evidence[]): Promise<EvidenceVerification> {
    const spans = evidence.filter((item) => item.kind === EvidenceKind.DOCUMENT_SPAN);
    const rejected: RejectedEvidence[] = [];
    const cache = new Map<string, Awaited<ReturnType<DocumentTextRepository['listByDocument']>>>();

    for (const item of spans) {
      const id = DOCUMENT_REF.exec(item.sourceRef)?.[1];
      const documentId = id === undefined ? undefined : DocumentIdSchema.safeParse(id);
      if (documentId?.success !== true) {
        rejected.push({ evidence: item, reason: 'MALFORMED_SOURCE_REF' });
        continue;
      }
      let parts = cache.get(documentId.data);
      if (parts === undefined) {
        parts = await this.texts.listByDocument(scope, documentId.data);
        cache.set(documentId.data, parts);
      }
      if (parts.length === 0) {
        // The document does not exist, or it belongs to another tenant; row-level
        // security makes those indistinguishable here, which is the correct answer.
        rejected.push({ evidence: item, reason: 'DOCUMENT_NOT_FOUND' });
        continue;
      }
      if (!verifyDocumentSpan(parts, item)) {
        rejected.push({ evidence: item, reason: 'SPAN_NOT_IN_DOCUMENT' });
      }
    }
    return { checked: spans.length, rejected };
  }
}
