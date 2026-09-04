import { z } from 'zod';

import { translatePgError } from '../../../../infrastructure/postgres/errors.js';
import { clientOf } from '../../../../infrastructure/postgres/transaction-runner.js';
import { OrganizationIdSchema, CaseIdSchema, UuidSchema } from '../../../../kernel/ids.js';
import { validationErrorFromZod } from '../../../../kernel/errors.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import type { ActionIntentRepository } from '../../application/ports.js';
import type { ActionIntent, ActionIntentState } from '../../domain/action-intent.js';

/**
 * The entitlement store on PostgreSQL.
 *
 * Two guarantees come from the database rather than from this code. The
 * primary key makes recording an entitlement idempotent, so approving twice
 * cannot authorise twice. And `SELECT … FOR UPDATE` makes an attempt
 * exclusive: a second worker blocks on the row until the first transaction
 * ends, then reads the state the first left. Row-level security does the rest
 * — a lock attempt from another tenant matches nothing and returns nothing.
 */
const COLUMNS = `
  organization_id, recommendation_id, case_id, tool, input_hash, idempotency_key,
  state, attempts, external_ref, last_error, created_at, updated_at
`;

const RowSchema = z
  .object({
    organization_id: OrganizationIdSchema,
    recommendation_id: UuidSchema,
    case_id: CaseIdSchema,
    tool: z.string(),
    input_hash: z.string(),
    idempotency_key: z.string(),
    state: z.enum(['pending', 'sent', 'failed']),
    attempts: z.number().int().min(0),
    external_ref: z.string().nullable(),
    last_error: z.string().nullable(),
    created_at: z.date(),
    updated_at: z.date(),
  })
  .loose();

function toIntent(row: unknown): ActionIntent {
  const parsed = RowSchema.safeParse(row);
  if (!parsed.success) {
    throw validationErrorFromZod(
      parsed.error,
      'INVALID_ACTION_INTENT_ROW',
      'An action intent row does not match its schema.',
    );
  }
  const value = parsed.data;
  return {
    organizationId: value.organization_id,
    recommendationId: value.recommendation_id,
    caseId: value.case_id,
    tool: value.tool,
    inputHash: value.input_hash,
    idempotencyKey: value.idempotency_key,
    state: value.state,
    attempts: value.attempts,
    externalRef: value.external_ref,
    lastError: value.last_error,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

export class PostgresActionIntentRepository implements ActionIntentRepository {
  async insert(scope: Scope, intent: ActionIntent): Promise<void> {
    try {
      await clientOf(scope).query(
        `INSERT INTO public.action_intents (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (organization_id, recommendation_id) DO NOTHING`,
        [
          intent.organizationId,
          intent.recommendationId,
          intent.caseId,
          intent.tool,
          intent.inputHash,
          intent.idempotencyKey,
          intent.state,
          intent.attempts,
          intent.externalRef,
          intent.lastError,
          intent.createdAt,
          intent.updatedAt,
        ],
      );
    } catch (error) {
      throw translatePgError(error);
    }
  }

  /**
   * Takes the row for update inside the caller's transaction, and holds it
   * until that transaction ends. This is the concurrency guarantee: whoever
   * arrives second waits here, and never runs the action in parallel.
   */
  async lock(scope: TenantScope, recommendationId: string): Promise<ActionIntent | undefined> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${COLUMNS} FROM public.action_intents
          WHERE organization_id = $1 AND recommendation_id = $2
          FOR UPDATE`,
        [scope.tenantId, recommendationId],
      );
      const row: unknown = result.rows[0];
      return row === undefined ? undefined : toIntent(row);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async find(scope: Scope, recommendationId: string): Promise<ActionIntent | undefined> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${COLUMNS} FROM public.action_intents WHERE recommendation_id = $1`,
        [recommendationId],
      );
      const row: unknown = result.rows[0];
      return row === undefined ? undefined : toIntent(row);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async settle(
    scope: Scope,
    recommendationId: string,
    patch: {
      readonly state: ActionIntentState;
      readonly attempts: number;
      readonly externalRef?: string | null;
      readonly lastError?: string | null;
      readonly updatedAt: Date;
    },
  ): Promise<void> {
    try {
      await clientOf(scope).query(
        `UPDATE public.action_intents
            SET state = $2,
                attempts = $3,
                external_ref = COALESCE($4, external_ref),
                last_error = $5,
                updated_at = $6
          WHERE recommendation_id = $1`,
        [
          recommendationId,
          patch.state,
          patch.attempts,
          patch.externalRef ?? null,
          patch.lastError ?? null,
          patch.updatedAt,
        ],
      );
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async listUnfinished(scope: TenantScope, limit: number): Promise<ActionIntent[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${COLUMNS} FROM public.action_intents
          WHERE organization_id = $1 AND state <> 'sent'
          ORDER BY created_at
          LIMIT $2`,
        [scope.tenantId, limit],
      );
      return result.rows.map((row: unknown) => toIntent(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }
}
