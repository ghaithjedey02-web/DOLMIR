import { type Clock, systemClock } from '../../../../kernel/clock.js';
import { ForbiddenError } from '../../../../kernel/errors.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import type { ConnectionCapability, TenantConnection } from '../../domain/connection.js';
import type {
  ConnectionPatch,
  ConnectionQuery,
  ConnectionRepository,
  IngestionNonceRepository,
  NewConnection,
} from '../../application/ports.js';

/** Same visibility rules as Row-Level Security, so unit tests prove the same behaviour. */
const visible = (scope: Scope, organizationId: string): boolean =>
  scope.kind === 'system' || scope.tenantId === organizationId;

export class InMemoryConnectionStore {
  readonly connections = new Map<string, TenantConnection>();
  readonly nonces = new Set<string>();
  readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }
}

export class InMemoryConnectionRepository implements ConnectionRepository {
  private readonly store: InMemoryConnectionStore;

  constructor(store: InMemoryConnectionStore) {
    this.store = store;
  }

  async insert(scope: TenantScope, connection: NewConnection): Promise<TenantConnection> {
    if (connection.organizationId !== scope.tenantId) {
      throw new ForbiddenError('DATABASE_ACCESS_DENIED', 'Row-level security refused the insert.');
    }
    const now = this.store.clock.now();
    const stored: TenantConnection = {
      ...connection,
      status: 'active',
      lastError: null,
      syncState: {},
      lastSyncAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.store.connections.set(stored.id, stored);
    return stored;
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: ConnectionPatch,
  ): Promise<TenantConnection | undefined> {
    const current = await this.findById(scope, id);
    if (current?.version !== expectedVersion) return undefined;
    const updated: TenantConnection = {
      ...current,
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      ...(patch.settings === undefined ? {} : { settings: { ...patch.settings } }),
      ...(patch.credentials === undefined ? {} : { credentials: patch.credentials }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.lastError === undefined ? {} : { lastError: patch.lastError }),
      ...(patch.syncState === undefined ? {} : { syncState: { ...patch.syncState } }),
      ...(patch.lastSyncAt === undefined ? {} : { lastSyncAt: patch.lastSyncAt }),
      version: current.version + 1,
      updatedAt: this.store.clock.now(),
    };
    this.store.connections.set(id, updated);
    return updated;
  }

  async findById(scope: Scope, id: string): Promise<TenantConnection | undefined> {
    const found = this.store.connections.get(id);
    return found !== undefined && visible(scope, found.organizationId) ? found : undefined;
  }

  async list(scope: TenantScope, query: ConnectionQuery): Promise<TenantConnection[]> {
    return [...this.store.connections.values()]
      .filter((item) => item.organizationId === scope.tenantId)
      .filter((item) => query.capability === undefined || item.capability === query.capability)
      .filter((item) => query.status === undefined || item.status === query.status)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, query.limit);
  }

  async listActiveAcrossTenants(
    scope: Scope,
    capability: ConnectionCapability,
    limit: number,
  ): Promise<TenantConnection[]> {
    return [...this.store.connections.values()]
      .filter((item) => visible(scope, item.organizationId))
      .filter((item) => item.capability === capability && item.status === 'active')
      .slice(0, limit);
  }
}

export class InMemoryIngestionNonceRepository implements IngestionNonceRepository {
  private readonly store: InMemoryConnectionStore;

  constructor(store: InMemoryConnectionStore) {
    this.store = store;
  }

  async claim(scope: TenantScope, keyId: string, nonce: string): Promise<boolean> {
    const key = `${scope.tenantId}:${keyId}:${nonce}`;
    if (this.store.nonces.has(key)) return false;
    this.store.nonces.add(key);
    return true;
  }
}
