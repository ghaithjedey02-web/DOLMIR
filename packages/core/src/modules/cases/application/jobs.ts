import { z } from 'zod';

import { DocumentIdSchema, OrganizationIdSchema, UuidSchema } from '../../../kernel/ids.js';
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

/**
 * Execution runs in the background too, and for a stronger reason: an approved
 * recommendation is work the company has committed to, so it must not depend
 * on the HTTP request that approved it staying alive. The approval transaction
 * records the entitlement; this job carries it out.
 *
 * Idempotent on both sides. The queue key is the recommendation, so approving
 * twice enqueues once; and the handler locks the entitlement row, so a retry
 * after success does nothing at all.
 */
export const executeRecommendationJob = defineJob({
  name: 'cases.execute_recommendation',
  payload: z.object({ tenantId: OrganizationIdSchema, recommendationId: UuidSchema }).strict(),
  retryLimit: 5,
  retryDelaySeconds: 30,
  expireInSeconds: 10 * 60,
});

/** The queue key of an execution: one in flight per recommendation, however often it is asked for. */
export function executionJobKey(recommendationId: string): string {
  return `execute:${recommendationId}`;
}
