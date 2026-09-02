import { ConflictError } from '../../../../kernel/errors.js';
import { type CorrelationId, newUuid } from '../../../../kernel/ids.js';
import { err, ok, type Result } from '../../../../kernel/result.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import type { Clock } from '../../../../kernel/clock.js';
import { systemClock } from '../../../../kernel/clock.js';
import type { LedgerRepository, ProjectionCheckpointRepository } from '../../application/ports.js';
import type {
  ExpectedVersion,
  LedgerEvent,
  NewLedgerEvent,
  StreamRef,
} from '../../domain/ledger-event.js';

/** Same semantics as the PostgreSQL adapter, in memory: per-tenant visibility, exact versions, idempotency. */
export class InMemoryLedgerRepository implements LedgerRepository {
  readonly events: LedgerEvent[] = [];
  private readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  async append(
    scope: TenantScope,
    stream: StreamRef,
    events: readonly NewLedgerEvent[],
    expectedVersion: ExpectedVersion,
    correlationId: CorrelationId | undefined,
  ): Promise<Result<LedgerEvent[], ConflictError>> {
    const keys = events.flatMap((e) => (e.idempotencyKey === undefined ? [] : [e.idempotencyKey]));
    if (keys.length > 0) {
      const existing = this.events.filter(
        (e) =>
          e.organizationId === scope.tenantId &&
          e.idempotencyKey !== null &&
          keys.includes(e.idempotencyKey),
      );
      if (existing.length > 0) {
        if (keys.length === events.length && existing.length === events.length) return ok(existing);
        return err(
          new ConflictError(
            'IDEMPOTENCY_CONFLICT',
            'Some events of this batch were already appended under their idempotency keys.',
          ),
        );
      }
    }
    const inStream = this.events.filter(
      (e) =>
        e.organizationId === scope.tenantId &&
        e.stream.type === stream.type &&
        e.stream.id === stream.id,
    );
    const version = inStream.length;
    const mismatch =
      (expectedVersion === 'none' && version !== 0) ||
      (typeof expectedVersion === 'number' && expectedVersion !== version);
    if (mismatch) {
      return err(
        new ConflictError('STREAM_VERSION_CONFLICT', 'The stream changed since it was read.', {
          details: { stream, expected: expectedVersion, actual: version },
        }),
      );
    }
    const appended = events.map((event, index) => ({
      id: newUuid(),
      organizationId: scope.tenantId,
      stream,
      streamSequence: version + index + 1,
      globalSequence: this.events.length + index + 1,
      eventType: event.eventType,
      schemaVersion: event.schemaVersion,
      payload: event.payload,
      provenance: event.provenance,
      occurredAt: event.occurredAt,
      recordedAt: this.clock.now(),
      correlationId: correlationId ?? null,
      causationId: event.causationId ?? null,
      idempotencyKey: event.idempotencyKey ?? null,
    }));
    this.events.push(...appended);
    return ok(appended);
  }

  async readStream(
    scope: TenantScope,
    stream: StreamRef,
    fromSequence = 1,
  ): Promise<LedgerEvent[]> {
    return this.events.filter(
      (e) =>
        e.organizationId === scope.tenantId &&
        e.stream.type === stream.type &&
        e.stream.id === stream.id &&
        e.streamSequence >= fromSequence,
    );
  }

  async readAll(scope: Scope, afterGlobalSequence: number, limit: number): Promise<LedgerEvent[]> {
    return this.events
      .filter((e) => scope.kind === 'system' || e.organizationId === scope.tenantId)
      .filter((e) => e.globalSequence > afterGlobalSequence)
      .slice(0, limit);
  }
}

export class InMemoryProjectionCheckpointRepository implements ProjectionCheckpointRepository {
  readonly checkpoints = new Map<string, number>();

  async get(_scope: Scope, projectionName: string): Promise<number> {
    return this.checkpoints.get(projectionName) ?? 0;
  }

  async set(_scope: Scope, projectionName: string, lastGlobalSequence: number): Promise<void> {
    this.checkpoints.set(projectionName, lastGlobalSequence);
  }
}
