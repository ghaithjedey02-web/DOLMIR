import { z } from 'zod';

import { translatePgError } from '../../../../infrastructure/postgres/errors.js';
import { clientOf } from '../../../../infrastructure/postgres/transaction-runner.js';
import { InternalError, validationErrorFromZod } from '../../../../kernel/errors.js';
import { ConnectionIdSchema, OrganizationIdSchema } from '../../../../kernel/ids.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import {
  ConnectionCapabilitySchema,
  ConnectionStatusSchema,
  EncryptedSecretSchema,
  ProviderKeySchema,
  type ConnectionCapability,
  type TenantConnection,
  TenantConnectionSchema,
} from '../../domain/connection.js';
import type {
  ConnectionPatch,
  ConnectionQuery,
  ConnectionRepository,
  IngestionNonceRepository,
  NewConnection,
} from '../../application/ports.js';

const COLUMNS =
  'id, organization_id, capability, provider, display_name, settings, credentials, status, last_error, sync_state, last_sync_at, version, created_at, updated_at';

const ConnectionRow = z.object({
  id: ConnectionIdSchema,
  organization_id: OrganizationIdSchema,
  capability: ConnectionCapabilitySchema,
  provider: ProviderKeySchema,
  display_name: z.string(),
  settings: z.record(z.string(), z.unknown()),
  credentials: EncryptedSecretSchema,
  status: ConnectionStatusSchema,
  last_error: z.string().nullable(),
  sync_state: z.record(z.string(), z.unknown()),
  last_sync_at: z.date().nullable(),
  version: z.number().int(),
  created_at: z.date(),
  updated_at: z.date(),
});

function toConnection(raw: unknown): TenantConnection {
  const parsed = ConnectionRow.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError(
      'ROW_SHAPE_MISMATCH',
      'A row of tenant_connections did not match its schema.',
      { cause: validationErrorFromZod(parsed.error) },
    );
  }
  const row = parsed.data;
  return TenantConnectionSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    capability: row.capability,
    provider: row.provider,
    displayName: row.display_name,
    settings: row.settings,
    credentials: row.credentials,
    status: row.status,
    lastError: row.last_error,
    syncState: row.sync_state,
    lastSyncAt: row.last_sync_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class PostgresConnectionRepository implements ConnectionRepository {
  async insert(scope: TenantScope, connection: NewConnection): Promise<TenantConnection> {
    try {
      const result = await clientOf(scope).query(
        `INSERT INTO public.tenant_connections
           (id, organization_id, capability, provider, display_name, settings, credentials,
            status, last_error, sync_state, last_sync_at, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'active', NULL, '{}'::jsonb, NULL, 1, now(), now())
         RETURNING ${COLUMNS}`,
        [
          connection.id,
          connection.organizationId,
          connection.capability,
          connection.provider,
          connection.displayName,
          JSON.stringify(connection.settings),
          JSON.stringify(connection.credentials),
        ],
      );
      return toConnection(result.rows[0]);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: ConnectionPatch,
  ): Promise<TenantConnection | undefined> {
    const assignments: string[] = [];
    const values: unknown[] = [id, expectedVersion];
    const set = (column: string, value: unknown, cast = ''): void => {
      values.push(value);
      assignments.push(`${column} = $${String(values.length)}${cast}`);
    };
    if (patch.displayName !== undefined) set('display_name', patch.displayName);
    if (patch.settings !== undefined) set('settings', JSON.stringify(patch.settings), '::jsonb');
    if (patch.credentials !== undefined) {
      set('credentials', JSON.stringify(patch.credentials), '::jsonb');
    }
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.lastError !== undefined) set('last_error', patch.lastError);
    if (patch.syncState !== undefined)
      set('sync_state', JSON.stringify(patch.syncState), '::jsonb');
    if (patch.lastSyncAt !== undefined) set('last_sync_at', patch.lastSyncAt);
    if (assignments.length === 0) return this.findById(scope, id);
    try {
      const result = await clientOf(scope).query(
        `UPDATE public.tenant_connections
            SET ${assignments.join(', ')}, version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2
          RETURNING ${COLUMNS}`,
        values,
      );
      const row: unknown = result.rows[0];
      return row === undefined ? undefined : toConnection(row);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async findById(scope: Scope, id: string): Promise<TenantConnection | undefined> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${COLUMNS} FROM public.tenant_connections WHERE id = $1`,
        [id],
      );
      const row: unknown = result.rows[0];
      return row === undefined ? undefined : toConnection(row);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async list(scope: TenantScope, query: ConnectionQuery): Promise<TenantConnection[]> {
    const conditions = ['organization_id = $1'];
    const values: unknown[] = [scope.tenantId, Math.min(Math.max(query.limit, 1), 200)];
    if (query.capability !== undefined) {
      values.push(query.capability);
      conditions.push(`capability = $${String(values.length)}`);
    }
    if (query.status !== undefined) {
      values.push(query.status);
      conditions.push(`status = $${String(values.length)}`);
    }
    try {
      const result = await clientOf(scope).query(
        `SELECT ${COLUMNS} FROM public.tenant_connections
          WHERE ${conditions.join(' AND ')}
          ORDER BY created_at LIMIT $2`,
        values,
      );
      return result.rows.map((row: unknown) => toConnection(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async listActiveAcrossTenants(
    scope: Scope,
    capability: ConnectionCapability,
    limit: number,
  ): Promise<TenantConnection[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${COLUMNS} FROM public.tenant_connections
          WHERE capability = $1 AND status = 'active'
          ORDER BY COALESCE(last_sync_at, to_timestamp(0)) LIMIT $2`,
        [capability, Math.min(Math.max(limit, 1), 1000)],
      );
      return result.rows.map((row: unknown) => toConnection(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }
}

export class PostgresIngestionNonceRepository implements IngestionNonceRepository {
  async claim(scope: TenantScope, keyId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    try {
      const result = await clientOf(scope).query(
        `INSERT INTO public.ingestion_nonces (organization_id, key_id, nonce, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, key_id, nonce) DO NOTHING`,
        [scope.tenantId, keyId, nonce, expiresAt],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      throw translatePgError(error);
    }
  }
}
