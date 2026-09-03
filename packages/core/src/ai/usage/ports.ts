import type { Scope, TenantScope } from '../../kernel/scope.js';
import type { AiUsageRecord, NewAiUsageRecordInput } from './ai-usage-record.js';

export interface AiUsageQuery {
  readonly limit: number;
  /** Only records that occurred strictly before this instant (paging). */
  readonly before?: Date;
  readonly useCase?: string;
}

export interface AiUsageSummaryQuery {
  readonly since?: Date;
}

/** Per use case and model: the numbers a cost report is made of. */
export interface AiUsageSummaryRow {
  readonly useCase: string;
  readonly model: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCost: number;
  readonly currency: 'USD';
  /** Calls whose model was unpriced — their cost is not in `estimatedCost`. */
  readonly unpricedCalls: number;
}

/** Storage port: append-only by contract. */
export interface AiUsageRepository {
  append(scope: Scope, record: AiUsageRecord): Promise<void>;
  list(scope: TenantScope, query: AiUsageQuery): Promise<AiUsageRecord[]>;
  summarize(scope: TenantScope, query: AiUsageSummaryQuery): Promise<AiUsageSummaryRow[]>;
}

/** What the recording provider depends on. */
export interface AiUsageRecorder {
  record(input: NewAiUsageRecordInput): Promise<AiUsageRecord>;
}
