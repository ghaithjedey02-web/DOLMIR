import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import type { Clock } from '../../../kernel/clock.js';
import { ActorType } from '../../../kernel/context.js';
import {
  type DomainError,
  NotFoundError,
  PreconditionFailedError,
  validationErrorFromZod,
} from '../../../kernel/errors.js';
import { type ConnectionId, newConnectionId } from '../../../kernel/ids.js';
import { type Logger, noopLogger } from '../../../kernel/logger.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import type { TenantScope, TransactionRunner } from '../../../kernel/scope.js';
import type { TenantContext } from '../../../kernel/tenant.js';
import { type Authorizer, Permission } from '../../access/index.js';
import type { AuditRecorder } from '../../audit/index.js';
import {
  type ConnectionCapability,
  ConnectionCapabilitySchema,
  type ConnectionStatus,
  ConnectionStatusSchema,
  type ConnectionView,
  INGESTION_ENDPOINT_PROVIDER,
  ProviderKeySchema,
  toConnectionView,
} from '../domain/connection.js';
import type { CredentialCipher } from '../domain/credential-cipher.js';
import type { ConnectionQuery, ConnectionRepository } from './ports.js';

/**
 * Creating, rotating and disabling connections (ADR-0013 §2). Credentials
 * arrive here once, in the clear, and leave encrypted; nothing this class
 * returns ever contains them. `connections:manage` is human-only, so a model
 * that reads a message asking for a new mailbox cannot act on it.
 *
 * The one exception to "a secret is never shown" is the ingestion key, which
 * is returned exactly once at creation because the caller must configure it
 * on the other side. It is not recoverable afterwards: it is rotated instead.
 */
export const NewConnectionInputSchema = z
  .object({
    capability: ConnectionCapabilitySchema,
    provider: ProviderKeySchema,
    displayName: z.string().trim().min(1).max(200),
    settings: z.record(z.string(), z.unknown()).default({}),
    /** In the clear here, encrypted before it is stored. */
    credentials: z.record(z.string(), z.unknown()),
  })
  .strict();
export type NewConnectionInput = z.input<typeof NewConnectionInputSchema>;

export interface ManageConnectionsDependencies {
  readonly transactions: TransactionRunner;
  readonly connections: ConnectionRepository;
  readonly cipher: CredentialCipher;
  readonly authorizer: Authorizer;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export interface IssuedIngestionKey {
  readonly connection: ConnectionView;
  readonly keyId: string;
  /** Shown once. The platform keeps only the encrypted copy. */
  readonly secret: string;
}

export class ManageConnections {
  private readonly deps: ManageConnectionsDependencies;
  private readonly logger: Logger;

  constructor(deps: ManageConnectionsDependencies) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
  }

  async create(
    tenant: TenantContext,
    rawInput: NewConnectionInput,
  ): Promise<Result<ConnectionView, DomainError>> {
    const permitted = this.deps.authorizer.require(tenant, Permission.CONNECTIONS_MANAGE);
    if (!permitted.ok) return err(permitted.error);
    const parsed = NewConnectionInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return err(
        validationErrorFromZod(
          parsed.error,
          'INVALID_CONNECTION',
          'The connection input is invalid.',
        ),
      );
    }
    const input = parsed.data;
    return this.deps.transactions.withTenant(tenant.organizationId, async (scope) => {
      const stored = await this.deps.connections.insert(scope, {
        id: newConnectionId(),
        organizationId: tenant.organizationId,
        capability: input.capability,
        provider: input.provider,
        displayName: input.displayName,
        settings: input.settings,
        credentials: this.deps.cipher.encrypt(tenant.organizationId, input.credentials),
      });
      await this.record(scope, tenant, 'connection.created', stored.id, {
        capability: stored.capability,
        provider: stored.provider,
        // The names of the credential fields, never their values.
        credentialFields: Object.keys(input.credentials).sort(),
      });
      this.logger.info('connection created', {
        connectionId: stored.id,
        capability: stored.capability,
        provider: stored.provider,
      });
      return ok(toConnectionView(stored));
    });
  }

  /**
   * A shared secret for the signed ingestion endpoint. The secret is returned
   * once; afterwards only its encrypted copy exists.
   */
  async issueIngestionKey(
    tenant: TenantContext,
    displayName: string,
  ): Promise<Result<IssuedIngestionKey, DomainError>> {
    const keyId = `ik_${randomBytes(8).toString('hex')}`;
    const secret = randomBytes(32).toString('base64');
    const created = await this.create(tenant, {
      capability: 'ingest_endpoint',
      provider: INGESTION_ENDPOINT_PROVIDER,
      displayName,
      settings: { keyId },
      credentials: { secret },
    });
    return created.ok ? ok({ connection: created.value, keyId, secret }) : err(created.error);
  }

  async rotateCredentials(
    tenant: TenantContext,
    id: ConnectionId,
    credentials: Readonly<Record<string, unknown>>,
  ): Promise<Result<ConnectionView, DomainError>> {
    return this.change(tenant, id, 'connection.credentials_rotated', (organizationId) => ({
      credentials: this.deps.cipher.encrypt(organizationId, credentials),
      status: 'active',
      lastError: null,
    }));
  }

  async updateSettings(
    tenant: TenantContext,
    id: ConnectionId,
    patch: { readonly displayName?: string; readonly settings?: Record<string, unknown> },
  ): Promise<Result<ConnectionView, DomainError>> {
    return this.change(tenant, id, 'connection.updated', () => ({
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      ...(patch.settings === undefined ? {} : { settings: patch.settings }),
    }));
  }

  async setStatus(
    tenant: TenantContext,
    id: ConnectionId,
    status: ConnectionStatus,
  ): Promise<Result<ConnectionView, DomainError>> {
    const parsed = ConnectionStatusSchema.safeParse(status);
    if (!parsed.success) {
      return err(validationErrorFromZod(parsed.error, 'INVALID_STATUS', 'Unknown status.'));
    }
    return this.change(tenant, id, 'connection.status_changed', () => ({
      status: parsed.data,
      ...(parsed.data === 'active' ? { lastError: null } : {}),
    }));
  }

  /** Connection metadata for the tenant. Never credentials, whatever the role. */
  async list(
    tenant: TenantContext,
    query: { readonly capability?: ConnectionCapability; readonly limit?: number },
  ): Promise<Result<ConnectionView[], DomainError>> {
    const permitted = this.deps.authorizer.require(tenant, Permission.CONNECTIONS_READ);
    if (!permitted.ok) return err(permitted.error);
    const criteria: ConnectionQuery = {
      limit: Math.min(Math.max(query.limit ?? 50, 1), 200),
      ...(query.capability === undefined ? {} : { capability: query.capability }),
    };
    const found = await this.deps.transactions.withTenant(tenant.organizationId, (scope) =>
      this.deps.connections.list(scope, criteria),
    );
    return ok(found.map(toConnectionView));
  }

  private async change(
    tenant: TenantContext,
    id: ConnectionId,
    action: string,
    patch: (organizationId: TenantContext['organizationId']) => Record<string, unknown>,
  ): Promise<Result<ConnectionView, DomainError>> {
    const permitted = this.deps.authorizer.require(tenant, Permission.CONNECTIONS_MANAGE);
    if (!permitted.ok) return err(permitted.error);
    return this.deps.transactions.withTenant(tenant.organizationId, async (scope) => {
      const current = await this.deps.connections.findById(scope, id);
      if (current === undefined) {
        return err(new NotFoundError('CONNECTION_NOT_FOUND', 'The connection was not found.'));
      }
      const updated = await this.deps.connections.update(
        scope,
        id,
        current.version,
        patch(tenant.organizationId),
      );
      if (updated === undefined) {
        return err(
          new PreconditionFailedError(
            'CONNECTION_CHANGED',
            'The connection changed while it was being updated.',
          ),
        );
      }
      await this.record(scope, tenant, action, id, {
        capability: updated.capability,
        provider: updated.provider,
        status: updated.status,
      });
      return ok(toConnectionView(updated));
    });
  }

  private async record(
    scope: TenantScope,
    tenant: TenantContext,
    action: string,
    id: ConnectionId,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(scope, {
      organizationId: tenant.organizationId,
      actor: { type: ActorType.USER, id: tenant.userId },
      action,
      target: { type: 'connection', id },
      details,
    });
  }
}
