import type { Clock } from '../../../kernel/clock.js';
import type { ExecutionContextProvider } from '../../../kernel/context.js';
import { validationErrorFromZod } from '../../../kernel/errors.js';
import { newUuid } from '../../../kernel/ids.js';
import { redactSecrets } from '../../../kernel/redaction.js';
import type { Scope, TenantScope } from '../../../kernel/scope.js';
import {
  type AuditEntry,
  AuditEntrySchema,
  type NewAuditEntryInput,
  NewAuditEntrySchema,
} from '../domain/audit-entry.js';
import type { AuditLogRepository, AuditQuery, AuditRecorder } from './ports.js';

export interface AuditTrailDependencies {
  readonly repository: AuditLogRepository;
  readonly clock: Clock;
  readonly context: ExecutionContextProvider;
}

/**
 * The one way to write the audit trail. Stamps id, time and the current
 * request/correlation ids, blanks secret-looking keys in `details`, validates,
 * appends. Invalid entries throw: an unauditable action must not proceed.
 */
export class AuditTrail implements AuditRecorder {
  private readonly deps: AuditTrailDependencies;

  constructor(deps: AuditTrailDependencies) {
    this.deps = deps;
  }

  async record(scope: Scope, input: NewAuditEntryInput): Promise<AuditEntry> {
    const parsed = NewAuditEntrySchema.safeParse(input);
    if (!parsed.success) {
      throw validationErrorFromZod(
        parsed.error,
        'INVALID_AUDIT_ENTRY',
        'The audit entry is invalid.',
      );
    }
    const context = this.deps.context.current();
    const entry = AuditEntrySchema.parse({
      ...parsed.data,
      details: redactSecrets(parsed.data.details),
      id: newUuid(),
      requestId: context?.requestId ?? null,
      correlationId: context?.correlationId ?? null,
      occurredAt: this.deps.clock.now(),
    });
    await this.deps.repository.append(scope, entry);
    return entry;
  }

  async list(scope: TenantScope, query: AuditQuery): Promise<AuditEntry[]> {
    return this.deps.repository.list(scope, query);
  }
}
