import type { EntityId } from '../../../kernel/ids.js';
import type { Scope, TenantScope } from '../../../kernel/scope.js';
import type {
  Entity,
  EntityAlias,
  EntityAliasKind,
  EntityKind,
  EntityStatus,
  NewEntity,
  NewEntityAlias,
} from '../domain/entity.js';

export interface EntityQuery {
  readonly limit: number;
  readonly kind?: EntityKind;
  /** Case-insensitive substring of the name or code. */
  readonly search?: string;
  readonly status?: EntityStatus;
}

export interface EntityPatch {
  readonly name?: string;
  readonly code?: string | null;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly status?: EntityStatus;
}

export interface EntityRepository {
  insert(scope: TenantScope, entity: NewEntity): Promise<Entity>;
  update(scope: TenantScope, id: EntityId, patch: EntityPatch): Promise<Entity | undefined>;
  findById(scope: Scope, id: EntityId): Promise<Entity | undefined>;
  findByIds(scope: Scope, ids: readonly EntityId[]): Promise<Entity[]>;
  list(scope: TenantScope, query: EntityQuery): Promise<Entity[]>;
}

export interface SimilarName {
  readonly entityId: EntityId;
  readonly value: string;
  /** Trigram similarity in [0, 1]. */
  readonly similarity: number;
}

export interface EntityAliasRepository {
  /** Adds an alias; returns the existing one when the same normalised value is already there. */
  add(scope: TenantScope, alias: NewEntityAlias): Promise<EntityAlias>;
  findByValue(scope: TenantScope, kind: EntityAliasKind, value: string): Promise<EntityAlias[]>;
  listForEntity(scope: Scope, entityId: EntityId): Promise<EntityAlias[]>;
  /** Name aliases similar to `nameKey`, best first. */
  similarNames(
    scope: TenantScope,
    entityKind: EntityKind,
    nameKey: string,
    limit: number,
  ): Promise<SimilarName[]>;
}
