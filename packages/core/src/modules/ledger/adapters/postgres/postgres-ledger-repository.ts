import { z } from 'zod';

import { ConflictError, InternalError, validationErrorFromZod } from '../../../../kernel/errors.js';
import {
  type CorrelationId,
  CorrelationIdSchema,
  OrganizationIdSchema,
  UuidSchema,
} from '../../../../kernel/ids.js';
import { err, ok, type Result } from '../../../../kernel/result.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import { translatePgError } from '../../../../infrastructure/postgres/errors.js';
import { clientOf } from '../../../../infrastructure/postgres/transaction-runner.js';
import type { LedgerRepository, ProjectionCheckpointRepository } from '../../application/ports.js';
import {
  type ExpectedVersion,
  type LedgerEvent,
  LedgerEventSchema,
  type NewLedgerEvent,
  ProvenanceSchema,
  type StreamRef,
} from '../../domain/ledger-event.js';

const RowSchema = z.object({
  id: UuidSchema,
  organization_id: OrganizationIdSchema,
  stream_type: z.string(),
  stream_id: z.string(),
  stream_sequence: z.coerce.number().int(),
  global_sequence: z.coerce.number().int(),
  event_type: z.string(),
  schema_version: z.number().int(),
  payload: z.record(z.string(), z.unknown()),
  provenance: ProvenanceSchema,
  occurred_at: z.date(),
  recorded_at: z.date(),
  correlation_id: CorrelationIdSchema.nullable(),
  causation_id: UuidSchema.nullable(),
  idempotency_key: z.string().nullable(),
});

const COLUMNS =
  'id, organization_id, stream_type, stream_id, stream_sequence, global_sequence, event_type, schema_version, payload, provenance, occurred_at, recorded_at, correlation_id, causation_id, idempotency_key';

function toEvent(raw: unknown): LedgerEvent {
  const parsed = RowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError(
      'ROW_SHAPE_MISMATCH',
      'A row of ledger_events did not match its schema.',
      {
        cause: validationErrorFromZod(parsed.error),
      },
    );
  }
  const row = parsed.data;
  return LedgerEventSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    stream: { type: row.stream_type, id: row.stream_id },
    streamSequence: row.stream_sequence,
    globalSequence: row.global_sequence,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    payload: row.payload,
    provenance: row.provenance,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    idempotencyKey: row.idempotency_key,
  });
}

/**
 * Appends serialise per stream with a transaction-scoped advisory lock, so
 * the observed version is exact and the unique constraint on
 * (organization, stream, sequence) is a backstop rather than the mechanism.
 */
export class PostgresLedgerRepository implements LedgerRepository {
  async append(
    scope: TenantScope,
    stream: StreamRef,
    events: readonly NewLedgerEvent[],
    expectedVersion: ExpectedVersion,
    correlationId: CorrelationId | undefined,
  ): Promise<Result<LedgerEvent[], ConflictError>> {
    const client = clientOf(scope);
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${scope.tenantId}:${stream.type}:${stream.id}`,
      ]);

      const keys = events.flatMap((e) =>
        e.idempotencyKey === undefined ? [] : [e.idempotencyKey],
      );
      if (keys.length > 0) {
        const existing = await client.query(
          `SELECT ${COLUMNS} FROM public.ledger_events
            WHERE organization_id = $1 AND idempotency_key = ANY($2::text[])
            ORDER BY global_sequence`,
          [scope.tenantId, keys],
        );
        if (existing.rowCount !== null && existing.rowCount > 0) {
          if (keys.length === events.length && existing.rowCount === events.length) {
            return ok(existing.rows.map((row: unknown) => toEvent(row)));
          }
          return err(
            new ConflictError(
              'IDEMPOTENCY_CONFLICT',
              'Some events of this batch were already appended under their idempotency keys.',
              { details: { stream, existing: existing.rowCount, batch: events.length } },
            ),
          );
        }
      }

      const current = await client.query<{ version: string }>(
        `SELECT coalesce(max(stream_sequence), 0)::text AS version FROM public.ledger_events
          WHERE organization_id = $1 AND stream_type = $2 AND stream_id = $3`,
        [scope.tenantId, stream.type, stream.id],
      );
      const version = Number(current.rows[0]?.version ?? '0');
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

      const appended: LedgerEvent[] = [];
      let sequence = version;
      for (const event of events) {
        sequence += 1;
        const result = await client.query(
          `INSERT INTO public.ledger_events
             (organization_id, stream_type, stream_id, stream_sequence, event_type, schema_version,
              payload, provenance, occurred_at, correlation_id, causation_id, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
           RETURNING ${COLUMNS}`,
          [
            scope.tenantId,
            stream.type,
            stream.id,
            sequence,
            event.eventType,
            event.schemaVersion,
            JSON.stringify(event.payload),
            JSON.stringify(event.provenance),
            event.occurredAt,
            correlationId ?? null,
            event.causationId ?? null,
            event.idempotencyKey ?? null,
          ],
        );
        appended.push(toEvent(result.rows[0]));
      }
      return ok(appended);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async readStream(
    scope: TenantScope,
    stream: StreamRef,
    fromSequence = 1,
  ): Promise<LedgerEvent[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${COLUMNS} FROM public.ledger_events
          WHERE organization_id = $1 AND stream_type = $2 AND stream_id = $3 AND stream_sequence >= $4
          ORDER BY stream_sequence`,
        [scope.tenantId, stream.type, stream.id, fromSequence],
      );
      return result.rows.map((row: unknown) => toEvent(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async readAll(scope: Scope, afterGlobalSequence: number, limit: number): Promise<LedgerEvent[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${COLUMNS} FROM public.ledger_events
          WHERE global_sequence > $1
          ORDER BY global_sequence
          LIMIT $2`,
        [afterGlobalSequence, Math.min(Math.max(limit, 1), 1000)],
      );
      return result.rows.map((row: unknown) => toEvent(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }
}

export class PostgresProjectionCheckpointRepository implements ProjectionCheckpointRepository {
  async get(scope: Scope, projectionName: string): Promise<number> {
    try {
      const result = await clientOf(scope).query<{ last: string }>(
        'SELECT last_global_sequence::text AS last FROM public.projection_checkpoints WHERE projection_name = $1',
        [projectionName],
      );
      return Number(result.rows[0]?.last ?? '0');
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async set(scope: Scope, projectionName: string, lastGlobalSequence: number): Promise<void> {
    try {
      await clientOf(scope).query(
        `INSERT INTO public.projection_checkpoints (projection_name, last_global_sequence)
         VALUES ($1, $2)
         ON CONFLICT (projection_name)
         DO UPDATE SET last_global_sequence = EXCLUDED.last_global_sequence, updated_at = now()`,
        [projectionName, lastGlobalSequence],
      );
    } catch (error) {
      throw translatePgError(error);
    }
  }
}
