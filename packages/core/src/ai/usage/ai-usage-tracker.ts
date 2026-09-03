import type { Clock } from '../../kernel/clock.js';
import type { ExecutionContextProvider } from '../../kernel/context.js';
import { validationErrorFromZod } from '../../kernel/errors.js';
import { newUuid } from '../../kernel/ids.js';
import type { TenantScope, TransactionRunner } from '../../kernel/scope.js';
import {
  type AiUsageRecord,
  AiUsageRecordSchema,
  type NewAiUsageRecordInput,
  NewAiUsageRecordSchema,
} from './ai-usage-record.js';
import type {
  AiUsageQuery,
  AiUsageRecorder,
  AiUsageRepository,
  AiUsageSummaryQuery,
  AiUsageSummaryRow,
} from './ports.js';

export interface AiUsageTrackerDependencies {
  readonly repository: AiUsageRepository;
  readonly transactions: TransactionRunner;
  readonly clock: Clock;
  readonly context: ExecutionContextProvider;
}

/**
 * The one way to write `ai_usage`. Stamps id, time and request context and
 * appends in the tenant's own scope (or, for tenant-less platform calls, in
 * an explicit system scope). Runs in its own short transaction: a model call
 * is never made while holding a database connection.
 */
export class AiUsageTracker implements AiUsageRecorder {
  private readonly deps: AiUsageTrackerDependencies;

  constructor(deps: AiUsageTrackerDependencies) {
    this.deps = deps;
  }

  async record(input: NewAiUsageRecordInput): Promise<AiUsageRecord> {
    const parsed = NewAiUsageRecordSchema.safeParse(input);
    if (!parsed.success) {
      throw validationErrorFromZod(
        parsed.error,
        'INVALID_AI_USAGE_RECORD',
        'The AI usage record is invalid.',
      );
    }
    const context = this.deps.context.current();
    const record = AiUsageRecordSchema.parse({
      ...parsed.data,
      id: newUuid(),
      requestId: context?.requestId ?? null,
      correlationId: context?.correlationId ?? null,
      occurredAt: this.deps.clock.now(),
    });
    if (record.organizationId === null) {
      await this.deps.transactions.withSystemScope('ai usage without tenant', (scope) =>
        this.deps.repository.append(scope, record),
      );
    } else {
      await this.deps.transactions.withTenant(record.organizationId, (scope) =>
        this.deps.repository.append(scope, record),
      );
    }
    return record;
  }

  async list(scope: TenantScope, query: AiUsageQuery): Promise<AiUsageRecord[]> {
    return this.deps.repository.list(scope, query);
  }

  async summarize(scope: TenantScope, query: AiUsageSummaryQuery): Promise<AiUsageSummaryRow[]> {
    return this.deps.repository.summarize(scope, query);
  }
}
