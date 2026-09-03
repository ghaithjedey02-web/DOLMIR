import { type Clock, systemClock } from '../../../../kernel/clock.js';
import { ConflictError, ForbiddenError } from '../../../../kernel/errors.js';
import { type EntityId, newEntityId, newUuid } from '../../../../kernel/ids.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import type {
  EntityAliasRepository,
  EntityPatch,
  EntityQuery,
  EntityRepository,
  SimilarName,
} from '../../application/ports.js';
import {
  type Entity,
  type EntityAlias,
  type EntityAliasKind,
  type EntityKind,
  type NewEntity,
  type NewEntityAlias,
  normaliseAliasValue,
} from '../../domain/entity.js';

const visible = (scope: Scope, organizationId: string): boolean =>
  scope.kind === 'system' || scope.tenantId === organizationId;

export class InMemoryEntityStore {
  readonly entities = new Map<EntityId, Entity>();
  readonly aliases: EntityAlias[] = [];
  readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }
}

export class InMemoryEntityRepository implements EntityRepository {
  private readonly store: InMemoryEntityStore;

  constructor(store: InMemoryEntityStore) {
    this.store = store;
  }

  async insert(scope: TenantScope, entity: NewEntity): Promise<Entity> {
    if (entity.organizationId !== scope.tenantId) {
      throw new ForbiddenError('DATABASE_ACCESS_DENIED', 'Row-level security refused the insert.');
    }
    const now = this.store.clock.now();
    const stored: Entity = {
      ...entity,
      id: newEntityId(),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.store.entities.set(stored.id, stored);
    return stored;
  }

  async update(scope: TenantScope, id: EntityId, patch: EntityPatch): Promise<Entity | undefined> {
    const existing = await this.findById(scope, id);
    if (existing === undefined) return undefined;
    const updated: Entity = {
      ...existing,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.code === undefined ? {} : { code: patch.code }),
      ...(patch.attributes === undefined ? {} : { attributes: { ...patch.attributes } }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      updatedAt: this.store.clock.now(),
    };
    this.store.entities.set(id, updated);
    return updated;
  }

  async findById(scope: Scope, id: EntityId): Promise<Entity | undefined> {
    const entity = this.store.entities.get(id);
    return entity !== undefined && visible(scope, entity.organizationId) ? entity : undefined;
  }

  async findByIds(scope: Scope, ids: readonly EntityId[]): Promise<Entity[]> {
    const found: Entity[] = [];
    for (const id of ids) {
      const entity = await this.findById(scope, id);
      if (entity !== undefined) found.push(entity);
    }
    return found;
  }

  async list(scope: TenantScope, query: EntityQuery): Promise<Entity[]> {
    const needle = query.search?.toLowerCase();
    return [...this.store.entities.values()]
      .filter((entity) => entity.organizationId === scope.tenantId)
      .filter((entity) => query.kind === undefined || entity.kind === query.kind)
      .filter((entity) => query.status === undefined || entity.status === query.status)
      .filter(
        (entity) =>
          needle === undefined ||
          entity.name.toLowerCase().includes(needle) ||
          (entity.code?.toLowerCase().includes(needle) ?? false),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, query.limit);
  }
}

/**
 * The similarity the PostgreSQL adapter uses: the greater of pg_trgm's
 * `similarity` (whole strings) and `word_similarity` (the query against the
 * best-matching run of words), so "Rossi" scores high against
 * "officine meccaniche rossi" while "Rosi Impiant" scores well against
 * "rossi impianti".
 */
export function nameSimilarity(query: string, value: string): number {
  const words = value.split(/\s+/).filter((w) => w.length > 0);
  let best = trigramSimilarity(query, value);
  for (let size = 1; size <= words.length; size += 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      best = Math.max(best, trigramSimilarity(query, words.slice(start, start + size).join(' ')));
    }
  }
  return Math.round(best * 1000) / 1000;
}

/** Trigram similarity as PostgreSQL's pg_trgm computes it (shared trigrams / union). */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

function trigrams(value: string): Set<string> {
  const result = new Set<string>();
  for (const word of value
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) result.add(padded.slice(i, i + 3));
  }
  return result;
}

export class InMemoryEntityAliasRepository implements EntityAliasRepository {
  private readonly store: InMemoryEntityStore;

  constructor(store: InMemoryEntityStore) {
    this.store = store;
  }

  async add(scope: TenantScope, alias: NewEntityAlias): Promise<EntityAlias> {
    const entity = this.store.entities.get(alias.entityId);
    if (entity?.organizationId !== scope.tenantId) {
      throw new ForbiddenError('DATABASE_ACCESS_DENIED', 'Row-level security refused the insert.');
    }
    const value = normaliseAliasValue(alias.kind, alias.value);
    const existing = this.store.aliases.find(
      (a) => a.organizationId === scope.tenantId && a.kind === alias.kind && a.value === value,
    );
    if (existing?.entityId === alias.entityId) return existing;
    if (existing !== undefined) {
      throw new ConflictError('UNIQUE_VIOLATION', 'A record with the same key already exists.', {
        details: { kind: alias.kind },
      });
    }
    const stored: EntityAlias = {
      id: newUuid(),
      organizationId: scope.tenantId,
      entityId: alias.entityId,
      kind: alias.kind,
      value,
      display: alias.value.trim(),
      createdAt: this.store.clock.now(),
    };
    this.store.aliases.push(stored);
    return stored;
  }

  async findByValue(
    scope: TenantScope,
    kind: EntityAliasKind,
    value: string,
  ): Promise<EntityAlias[]> {
    return this.store.aliases.filter(
      (a) => a.organizationId === scope.tenantId && a.kind === kind && a.value === value,
    );
  }

  async listForEntity(scope: Scope, entityId: EntityId): Promise<EntityAlias[]> {
    return this.store.aliases.filter(
      (a) => a.entityId === entityId && visible(scope, a.organizationId),
    );
  }

  async similarNames(
    scope: TenantScope,
    entityKind: EntityKind,
    nameKey: string,
    limit: number,
  ): Promise<SimilarName[]> {
    return this.store.aliases
      .filter((a) => a.organizationId === scope.tenantId && a.kind === 'name')
      .filter((a) => this.store.entities.get(a.entityId)?.kind === entityKind)
      .map((a) => ({
        entityId: a.entityId,
        value: a.display,
        similarity: nameSimilarity(nameKey, a.value),
      }))
      .filter((s) => s.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }
}
