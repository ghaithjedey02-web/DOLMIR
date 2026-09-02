import type { ConflictError } from '../../../kernel/errors.js';
import type { CorrelationId } from '../../../kernel/ids.js';
import type { Result } from '../../../kernel/result.js';
import type { Scope, TenantScope } from '../../../kernel/scope.js';
import type {
  ExpectedVersion,
  LedgerEvent,
  NewLedgerEvent,
  StreamRef,
} from '../domain/ledger-event.js';

/**
 * Storage port for the ledger. Append-only by contract: no update, no delete.
 * A version mismatch is a value (`ConflictError`), because it is an expected
 * outcome of concurrent writers, not a failure of the infrastructure.
 */
export interface LedgerRepository {
  append(
    scope: TenantScope,
    stream: StreamRef,
    events: readonly NewLedgerEvent[],
    expectedVersion: ExpectedVersion,
    correlationId: CorrelationId | undefined,
  ): Promise<Result<LedgerEvent[], ConflictError>>;

  readStream(scope: TenantScope, stream: StreamRef, fromSequence?: number): Promise<LedgerEvent[]>;

  /** Events after a global position, in order. Under tenant scope only the tenant's events appear. */
  readAll(scope: Scope, afterGlobalSequence: number, limit: number): Promise<LedgerEvent[]>;
}

export interface ProjectionCheckpointRepository {
  /** The last global sequence a projection has applied; 0 when it never ran. */
  get(scope: Scope, projectionName: string): Promise<number>;
  set(scope: Scope, projectionName: string, lastGlobalSequence: number): Promise<void>;
}
