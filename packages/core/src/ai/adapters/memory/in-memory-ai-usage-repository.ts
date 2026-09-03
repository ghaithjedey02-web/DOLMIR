import { ForbiddenError } from '../../../kernel/errors.js';
import type { Scope, TenantScope } from '../../../kernel/scope.js';
import type { AiUsageRecord } from '../../usage/ai-usage-record.js';
import type {
  AiUsageQuery,
  AiUsageRepository,
  AiUsageSummaryQuery,
  AiUsageSummaryRow,
} from '../../usage/ports.js';

/** Emulates the `ai_usage` policies: tenant rows need tenant or system scope; platform rows need system scope. */
export class InMemoryAiUsageRepository implements AiUsageRepository {
  readonly records: AiUsageRecord[] = [];

  async append(scope: Scope, record: AiUsageRecord): Promise<void> {
    const allowed =
      record.organizationId === null
        ? scope.kind === 'system'
        : scope.kind === 'system' || scope.tenantId === record.organizationId;
    if (!allowed) {
      throw new ForbiddenError('DATABASE_ACCESS_DENIED', 'Row-level security refused the insert.');
    }
    this.records.push(record);
  }

  async list(scope: TenantScope, query: AiUsageQuery): Promise<AiUsageRecord[]> {
    return this.records
      .filter((record) => record.organizationId === scope.tenantId)
      .filter((record) => query.before === undefined || record.occurredAt < query.before)
      .filter((record) => query.useCase === undefined || record.useCase === query.useCase)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, query.limit);
  }

  async summarize(scope: TenantScope, query: AiUsageSummaryQuery): Promise<AiUsageSummaryRow[]> {
    const groups = new Map<string, AiUsageSummaryRow>();
    for (const record of this.records) {
      if (record.organizationId !== scope.tenantId) continue;
      if (query.since !== undefined && record.occurredAt < query.since) continue;
      const key = `${record.useCase} ${record.model}`;
      const current = groups.get(key) ?? {
        useCase: record.useCase,
        model: record.model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        currency: 'USD',
        unpricedCalls: 0,
      };
      groups.set(key, {
        ...current,
        calls: current.calls + 1,
        inputTokens: current.inputTokens + record.inputTokens,
        outputTokens: current.outputTokens + record.outputTokens,
        estimatedCost: Math.round((current.estimatedCost + record.estimatedCost) * 1e8) / 1e8,
        unpricedCalls: current.unpricedCalls + (record.priced ? 0 : 1),
      });
    }
    return [...groups.values()].sort(
      (a, b) => a.useCase.localeCompare(b.useCase) || a.model.localeCompare(b.model),
    );
  }
}
