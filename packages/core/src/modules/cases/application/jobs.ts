import { z } from 'zod';

import { DocumentIdSchema, OrganizationIdSchema } from '../../../kernel/ids.js';
import { defineJob } from '../../../kernel/jobs.js';

/**
 * Analysis runs in the background (ADR-0014): ingestion returns as soon as the
 * document exists, and the AI Systems look at it afterwards. The payload names
 * a tenant and a document, never content, and the handler re-enters that
 * tenant's scope before touching anything.
 *
 * The job is idempotent by construction: `AnalyzeDocument` opens at most one
 * case per document and system, so a retry after a crash finds the existing
 * case and does nothing.
 */
export const analyzeDocumentJob = defineJob({
  name: 'document.analyze',
  payload: z.object({ tenantId: OrganizationIdSchema, documentId: DocumentIdSchema }).strict(),
  retryLimit: 3,
  retryDelaySeconds: 30,
  expireInSeconds: 10 * 60,
});
