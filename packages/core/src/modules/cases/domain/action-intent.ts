import { z } from 'zod';

import { CaseIdSchema, OrganizationIdSchema, UuidSchema } from '../../../kernel/ids.js';

/**
 * The platform's entitlement to perform one external action, recorded durably
 * in the transaction that authorises it.
 *
 * It exists so that "a human approved this" and "the work will happen" are the
 * same commit. Nothing executes without one, and the row is what a worker
 * locks, so two workers cannot both act.
 */
export const ActionIntentState = {
  /** Authorised, never yet carried out to a committed conclusion. */
  PENDING: 'pending',
  /** Carried out; the outcome is persisted. Later attempts do nothing. */
  SENT: 'sent',
  /** An attempt committed a failure. Retryable under the same identity. */
  FAILED: 'failed',
} as const;
export type ActionIntentState = (typeof ActionIntentState)[keyof typeof ActionIntentState];

export const ActionIntentSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    recommendationId: UuidSchema,
    caseId: CaseIdSchema,
    tool: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    /** The input the authorisation covers; an attempt on anything else is refused. */
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** Stable across every attempt, so the outside world sees one identity. */
    idempotencyKey: z.string().min(8).max(200),
    state: z.enum(['pending', 'sent', 'failed']),
    /** Attempts that reached a commit. One that crashed mid-flight is not counted. */
    attempts: z.number().int().min(0),
    externalRef: z.string().min(1).max(500).nullable(),
    lastError: z.string().min(1).max(2000).nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();
export type ActionIntent = z.infer<typeof ActionIntentSchema>;

/**
 * The outbound identity of an authorised action: the recommendation it serves
 * and the input that was approved. It is deterministic, so a retry carries the
 * identity of the attempt it repeats, and it changes if what was approved
 * changes — a different input is a different action, not another try.
 */
export function actionIdempotencyKey(recommendationId: string, inputHash: string): string {
  return `${recommendationId}.${inputHash.slice(0, 16)}`;
}
