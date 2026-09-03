import { z } from 'zod';

import { translatePgError } from '../../../infrastructure/postgres/errors.js';
import { clientOf } from '../../../infrastructure/postgres/transaction-runner.js';
import { InternalError, validationErrorFromZod } from '../../../kernel/errors.js';
import {
  CorrelationIdSchema,
  OrganizationIdSchema,
  RequestIdSchema,
  UuidSchema,
} from '../../../kernel/ids.js';
import type { Scope, TenantScope } from '../../../kernel/scope.js';
import { LlmTierSchema } from '../../llm/port.js';
import { type AiUsageRecord, AiUsageRecordSchema } from '../../usage/ai-usage-record.js';
import type {
  AiUsageQuery,
  AiUsageRepository,
  AiUsageSummaryQuery,
  AiUsageSummaryRow,
} from '../../usage/ports.js';

/** `numeric` and aggregate columns arrive from pg as strings. */
const numeric = z.union([z.string(), z.number()]).transform(Number);

const RowSchema = z.object({
  id: UuidSchema,
  organization_id: OrganizationIdSchema.nullable(),
  provider: z.string(),
  model: z.string(),
  tier: LlmTierSchema,
  operation: z.string(),
  use_case: z.string(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cache_read_tokens: z.number().int(),
  cache_write_tokens: z.number().int(),
  estimated_cost: numeric,
  currency: z.literal('USD'),
  pricing_version: z.number().int(),
  priced: z.boolean(),
  latency_ms: z.number().int(),
  succeeded: z.boolean(),
  error_kind: z.string().nullable(),
  cached: z.boolean(),
  request_id: RequestIdSchema.nullable(),
  correlation_id: CorrelationIdSchema.nullable(),
  occurred_at: z.date(),
});

const SummaryRowSchema = z.object({
  use_case: z.string(),
  model: z.string(),
  calls: numeric,
  input_tokens: numeric,
  output_tokens: numeric,
  estimated_cost: numeric,
  unpriced_calls: numeric,
});

const COLUMNS =
  'id, organization_id, provider, model, tier, operation, use_case, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost, currency, pricing_version, priced, latency_ms, succeeded, error_kind, cached, request_id, correlation_id, occurred_at';

function toRecord(raw: unknown): AiUsageRecord {
  const parsed = RowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError('ROW_SHAPE_MISMATCH', 'A row of ai_usage did not match its schema.', {
      cause: validationErrorFromZod(parsed.error),
    });
  }
  const row = parsed.data;
  return AiUsageRecordSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    provider: row.provider,
    model: row.model,
    tier: row.tier,
    operation: row.operation,
    useCase: row.use_case,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    estimatedCost: row.estimated_cost,
    currency: row.currency,
    pricingVersion: row.pricing_version,
    priced: row.priced,
    latencyMs: row.latency_ms,
    succeeded: row.succeeded,
    errorKind: row.error_kind,
    cached: row.cached,
    requestId: row.request_id,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
  });
}

function toSummaryRow(raw: unknown): AiUsageSummaryRow {
  const parsed = SummaryRowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError(
      'ROW_SHAPE_MISMATCH',
      'An ai_usage summary row did not match its schema.',
      { cause: validationErrorFromZod(parsed.error) },
    );
  }
  const row = parsed.data;
  return {
    useCase: row.use_case,
    model: row.model,
    calls: row.calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    estimatedCost: row.estimated_cost,
    currency: 'USD',
    unpricedCalls: row.unpriced_calls,
  };
}

export class PostgresAiUsageRepository implements AiUsageRepository {
  async append(scope: Scope, record: AiUsageRecord): Promise<void> {
    try {
      await clientOf(scope).query(
        `INSERT INTO public.ai_usage
           (id, organization_id, provider, model, tier, operation, use_case,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            estimated_cost, currency, pricing_version, priced, latency_ms,
            succeeded, error_kind, cached, request_id, correlation_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
        [
          record.id,
          record.organizationId,
          record.provider,
          record.model,
          record.tier,
          record.operation,
          record.useCase,
          record.inputTokens,
          record.outputTokens,
          record.cacheReadTokens,
          record.cacheWriteTokens,
          record.estimatedCost.toFixed(8),
          record.currency,
          record.pricingVersion,
          record.priced,
          record.latencyMs,
          record.succeeded,
          record.errorKind,
          record.cached,
          record.requestId,
          record.correlationId,
          record.occurredAt,
        ],
      );
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async list(scope: TenantScope, query: AiUsageQuery): Promise<AiUsageRecord[]> {
    const values: unknown[] = [scope.tenantId, Math.min(Math.max(query.limit, 1), 500)];
    const conditions = ['organization_id = $1'];
    if (query.before !== undefined) {
      values.push(query.before);
      conditions.push(`occurred_at < $${values.length}`);
    }
    if (query.useCase !== undefined) {
      values.push(query.useCase);
      conditions.push(`use_case = $${values.length}`);
    }
    try {
      const result = await clientOf(scope).query(
        `SELECT ${COLUMNS} FROM public.ai_usage
          WHERE ${conditions.join(' AND ')}
          ORDER BY occurred_at DESC, recorded_at DESC
          LIMIT $2`,
        values,
      );
      return result.rows.map((row: unknown) => toRecord(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async summarize(scope: TenantScope, query: AiUsageSummaryQuery): Promise<AiUsageSummaryRow[]> {
    const values: unknown[] = [scope.tenantId];
    const conditions = ['organization_id = $1'];
    if (query.since !== undefined) {
      values.push(query.since);
      conditions.push(`occurred_at >= $${values.length}`);
    }
    try {
      const result = await clientOf(scope).query(
        `SELECT use_case, model,
                count(*)::bigint AS calls,
                sum(input_tokens)::bigint AS input_tokens,
                sum(output_tokens)::bigint AS output_tokens,
                sum(estimated_cost) AS estimated_cost,
                count(*) FILTER (WHERE NOT priced)::bigint AS unpriced_calls
           FROM public.ai_usage
          WHERE ${conditions.join(' AND ')}
          GROUP BY use_case, model
          ORDER BY use_case, model`,
        values,
      );
      return result.rows.map((row: unknown) => toSummaryRow(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }
}
