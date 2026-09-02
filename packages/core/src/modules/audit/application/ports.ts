import type { Scope, TenantScope } from '../../../kernel/scope.js';
import type { AuditEntry, NewAuditEntryInput } from '../domain/audit-entry.js';

export interface AuditQuery {
  readonly limit: number;
  /** Only entries that occurred strictly before this instant (for paging). */
  readonly before?: Date;
  readonly action?: string;
}

/** Storage port: append-only by contract — there is no update or delete. */
export interface AuditLogRepository {
  append(scope: Scope, entry: AuditEntry): Promise<void>;
  list(scope: TenantScope, query: AuditQuery): Promise<AuditEntry[]>;
}

/** What other modules depend on to leave a trace. */
export interface AuditRecorder {
  record(scope: Scope, entry: NewAuditEntryInput): Promise<AuditEntry>;
}
