import { z } from 'zod';

import {
  CorrelationIdSchema,
  OrganizationIdSchema,
  RequestIdSchema,
  UuidSchema,
} from '../../kernel/ids.js';
import { LlmTierSchema, OperationNameSchema } from '../llm/port.js';

/**
 * One AI call, priced (Directive §19, plan §G). Written for every call —
 * successful, failed, cached — so cost per tenant, model, operation and use
 * case is a query, not an estimate. Immutable once written (`ai_usage` is
 * append-only).
 */
const nonNegativeInt = z.number().int().min(0);

const recordShape = {
  /** `null` for platform-level calls (evals, diagnostics). */
  organizationId: OrganizationIdSchema.nullable(),
  provider: z.string().trim().min(1).max(50),
  model: z.string().trim().min(1).max(100),
  tier: LlmTierSchema,
  operation: OperationNameSchema,
  useCase: OperationNameSchema,
  inputTokens: nonNegativeInt,
  outputTokens: nonNegativeInt,
  cacheReadTokens: nonNegativeInt,
  cacheWriteTokens: nonNegativeInt,
  estimatedCost: z.number().min(0),
  currency: z.literal('USD'),
  pricingVersion: nonNegativeInt,
  /** False when the model was absent from the cost book: tokens are real, the zero estimate is not. */
  priced: z.boolean(),
  latencyMs: nonNegativeInt,
  succeeded: z.boolean(),
  /** The `LlmErrorKind` of a failed call; `null` on success. */
  errorKind: z.string().trim().min(1).max(50).nullable(),
  cached: z.boolean(),
};

const consistentOutcome = (
  value: { succeeded: boolean; errorKind: string | null },
  ctx: z.RefinementCtx,
): void => {
  if (value.succeeded === (value.errorKind !== null)) {
    ctx.addIssue({
      code: 'custom',
      path: ['errorKind'],
      message: 'errorKind must be null exactly when the call succeeded',
    });
  }
};

export const NewAiUsageRecordSchema = z
  .object({
    ...recordShape,
    cacheReadTokens: nonNegativeInt.default(0),
    cacheWriteTokens: nonNegativeInt.default(0),
    cached: z.boolean().default(false),
  })
  .strict()
  .superRefine(consistentOutcome);
export type NewAiUsageRecord = z.infer<typeof NewAiUsageRecordSchema>;
export type NewAiUsageRecordInput = z.input<typeof NewAiUsageRecordSchema>;

export const AiUsageRecordSchema = z
  .object({
    ...recordShape,
    id: UuidSchema,
    requestId: RequestIdSchema.nullable(),
    correlationId: CorrelationIdSchema.nullable(),
    occurredAt: z.date(),
  })
  .strict()
  .superRefine(consistentOutcome);
export type AiUsageRecord = z.infer<typeof AiUsageRecordSchema>;
