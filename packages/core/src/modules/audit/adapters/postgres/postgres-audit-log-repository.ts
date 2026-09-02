import { z } from 'zod';

import { ActorTypeSchema } from '../../../../kernel/context.js';
import { InternalError, validationErrorFromZod } from '../../../../kernel/errors.js';
import {
  CorrelationIdSchema,
  OrganizationIdSchema,
  RequestIdSchema,
  UuidSchema,
} from '../../../../kernel/ids.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import { translatePgError } from '../../../../infrastructure/postgres/errors.js';
import { clientOf } from '../../../../infrastructure/postgres/transaction-runner.js';
import type { AuditLogRepository, AuditQuery } from '../../application/ports.js';
import { type AuditEntry, AuditEntrySchema } from '../../domain/audit-entry.js';

const RowSchema = z.object({
  id: UuidSchema,
  organization_id: OrganizationIdSchema.nullable(),
  actor_type: ActorTypeSchema,
  actor_id: z.string(),
  actor_on_behalf_of: z.string().nullable(),
  action: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  outcome: z.enum(['success', 'failure', 'denied']),
  request_id: RequestIdSchema.nullable(),
  correlation_id: CorrelationIdSchema.nullable(),
  details: z.record(z.string(), z.unknown()),
  occurred_at: z.date(),
});

const COLUMNS =
  'id, organization_id, actor_type, actor_id, actor_on_behalf_of, action, target_type, target_id, outcome, request_id, correlation_id, details, occurred_at';

function toEntry(raw: unknown): AuditEntry {
  const parsed = RowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError('ROW_SHAPE_MISMATCH', 'A row of audit_log did not match its schema.', {
      cause: validationErrorFromZod(parsed.error),
    });
  }
  const row = parsed.data;
  return AuditEntrySchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    actor: {
      type: row.actor_type,
      id: row.actor_id,
      ...(row.actor_on_behalf_of === null ? {} : { onBehalfOf: row.actor_on_behalf_of }),
    },
    action: row.action,
    target:
      row.target_type === null || row.target_id === null
        ? null
        : { type: row.target_type, id: row.target_id },
    outcome: row.outcome,
    details: row.details,
    requestId: row.request_id,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
  });
}

export class PostgresAuditLogRepository implements AuditLogRepository {
  async append(scope: Scope, entry: AuditEntry): Promise<void> {
    try {
      await clientOf(scope).query(
        `INSERT INTO public.audit_log
           (id, organization_id, actor_type, actor_id, actor_on_behalf_of, action, target_type, target_id,
            outcome, request_id, correlation_id, details, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
        [
          entry.id,
          entry.organizationId,
          entry.actor.type,
          entry.actor.id,
          entry.actor.onBehalfOf ?? null,
          entry.action,
          entry.target?.type ?? null,
          entry.target?.id ?? null,
          entry.outcome,
          entry.requestId,
          entry.correlationId,
          JSON.stringify(entry.details),
          entry.occurredAt,
        ],
      );
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async list(scope: TenantScope, query: AuditQuery): Promise<AuditEntry[]> {
    const values: unknown[] = [scope.tenantId, Math.min(Math.max(query.limit, 1), 500)];
    const conditions = ['organization_id = $1'];
    if (query.before !== undefined) {
      values.push(query.before);
      conditions.push(`occurred_at < $${values.length}`);
    }
    if (query.action !== undefined) {
      values.push(query.action);
      conditions.push(`action = $${values.length}`);
    }
    try {
      const result = await clientOf(scope).query(
        `SELECT ${COLUMNS} FROM public.audit_log
          WHERE ${conditions.join(' AND ')}
          ORDER BY occurred_at DESC, recorded_at DESC
          LIMIT $2`,
        values,
      );
      return result.rows.map((row: unknown) => toEntry(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }
}
