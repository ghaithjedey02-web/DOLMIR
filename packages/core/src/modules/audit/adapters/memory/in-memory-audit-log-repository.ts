import { ForbiddenError } from '../../../../kernel/errors.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import type { AuditLogRepository, AuditQuery } from '../../application/ports.js';
import type { AuditEntry } from '../../domain/audit-entry.js';

/** Emulates the audit_log policies: tenant rows need tenant or system scope; platform rows need system scope. */
export class InMemoryAuditLogRepository implements AuditLogRepository {
  readonly entries: AuditEntry[] = [];

  async append(scope: Scope, entry: AuditEntry): Promise<void> {
    const allowed =
      entry.organizationId === null
        ? scope.kind === 'system'
        : scope.kind === 'system' || scope.tenantId === entry.organizationId;
    if (!allowed) {
      throw new ForbiddenError('DATABASE_ACCESS_DENIED', 'Row-level security refused the insert.');
    }
    this.entries.push(entry);
  }

  async list(scope: TenantScope, query: AuditQuery): Promise<AuditEntry[]> {
    return this.entries
      .filter((entry) => entry.organizationId === scope.tenantId)
      .filter((entry) => query.before === undefined || entry.occurredAt < query.before)
      .filter((entry) => query.action === undefined || entry.action === query.action)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, query.limit);
  }
}
