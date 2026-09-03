import { z } from 'zod';

import { translatePgError } from '../../../../infrastructure/postgres/errors.js';
import { clientOf } from '../../../../infrastructure/postgres/transaction-runner.js';
import { InternalError, validationErrorFromZod } from '../../../../kernel/errors.js';
import {
  type EntityId,
  EntityIdSchema,
  OrganizationIdSchema,
  UuidSchema,
} from '../../../../kernel/ids.js';
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
  EntityAliasKindSchema,
  EntityAliasSchema,
  type EntityKind,
  EntityKindSchema,
  EntitySchema,
  EntityStatusSchema,
  type NewEntity,
  type NewEntityAlias,
  normaliseAliasValue,
} from '../../domain/entity.js';

const EntityRowSchema = z.object({
  id: EntityIdSchema,
  organization_id: OrganizationIdSchema,
  kind: EntityKindSchema,
  name: z.string(),
  code: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  status: EntityStatusSchema,
  created_at: z.date(),
  updated_at: z.date(),
});

const AliasRowSchema = z.object({
  id: UuidSchema,
  organization_id: OrganizationIdSchema,
  entity_id: EntityIdSchema,
  kind: EntityAliasKindSchema,
  value: z.string(),
  display: z.string(),
  created_at: z.date(),
});

const SimilarRowSchema = z.object({
  entity_id: EntityIdSchema,
  display: z.string(),
  similarity: z.union([z.string(), z.number()]).transform(Number),
});

const ENTITY_COLUMNS =
  'id, organization_id, kind, name, code, attributes, status, created_at, updated_at';
const ALIAS_COLUMNS = 'id, organization_id, entity_id, kind, value, display, created_at';

function toEntity(raw: unknown): Entity {
  const parsed = EntityRowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError('ROW_SHAPE_MISMATCH', 'A row of entities did not match its schema.', {
      cause: validationErrorFromZod(parsed.error),
    });
  }
  const row = parsed.data;
  return EntitySchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    kind: row.kind,
    name: row.name,
    code: row.code,
    attributes: row.attributes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toAlias(raw: unknown): EntityAlias {
  const parsed = AliasRowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError(
      'ROW_SHAPE_MISMATCH',
      'A row of entity_aliases did not match its schema.',
      {
        cause: validationErrorFromZod(parsed.error),
      },
    );
  }
  const row = parsed.data;
  return EntityAliasSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    entityId: row.entity_id,
    kind: row.kind,
    value: row.value,
    display: row.display,
    createdAt: row.created_at,
  });
}

export class PostgresEntityRepository implements EntityRepository {
  async insert(scope: TenantScope, entity: NewEntity): Promise<Entity> {
    try {
      const result = await clientOf(scope).query(
        `INSERT INTO public.entities (organization_id, kind, name, code, attributes)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING ${ENTITY_COLUMNS}`,
        [
          entity.organizationId,
          entity.kind,
          entity.name,
          entity.code,
          JSON.stringify(entity.attributes),
        ],
      );
      return toEntity(result.rows[0]);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async update(scope: TenantScope, id: EntityId, patch: EntityPatch): Promise<Entity | undefined> {
    try {
      const result = await clientOf(scope).query(
        `UPDATE public.entities
            SET name = COALESCE($2, name),
                code = CASE WHEN $3::boolean THEN $4 ELSE code END,
                attributes = COALESCE($5::jsonb, attributes),
                status = COALESCE($6, status)
          WHERE id = $1
          RETURNING ${ENTITY_COLUMNS}`,
        [
          id,
          patch.name ?? null,
          patch.code !== undefined,
          patch.code ?? null,
          patch.attributes === undefined ? null : JSON.stringify(patch.attributes),
          patch.status ?? null,
        ],
      );
      const row: unknown = result.rows[0];
      return row === undefined ? undefined : toEntity(row);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async findById(scope: Scope, id: EntityId): Promise<Entity | undefined> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${ENTITY_COLUMNS} FROM public.entities WHERE id = $1`,
        [id],
      );
      const row: unknown = result.rows[0];
      return row === undefined ? undefined : toEntity(row);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async findByIds(scope: Scope, ids: readonly EntityId[]): Promise<Entity[]> {
    if (ids.length === 0) return [];
    try {
      const result = await clientOf(scope).query(
        `SELECT ${ENTITY_COLUMNS} FROM public.entities WHERE id = ANY($1::uuid[])`,
        [[...ids]],
      );
      return result.rows.map((row: unknown) => toEntity(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async list(scope: TenantScope, query: EntityQuery): Promise<Entity[]> {
    const values: unknown[] = [scope.tenantId, Math.min(Math.max(query.limit, 1), 500)];
    const conditions = ['organization_id = $1'];
    if (query.kind !== undefined) {
      values.push(query.kind);
      conditions.push(`kind = $${values.length}`);
    }
    if (query.status !== undefined) {
      values.push(query.status);
      conditions.push(`status = $${values.length}`);
    }
    if (query.search !== undefined && query.search.trim().length > 0) {
      values.push(`%${query.search.trim()}%`);
      conditions.push(`(name ILIKE $${values.length} OR code ILIKE $${values.length})`);
    }
    try {
      const result = await clientOf(scope).query(
        `SELECT ${ENTITY_COLUMNS} FROM public.entities
          WHERE ${conditions.join(' AND ')}
          ORDER BY name, id
          LIMIT $2`,
        values,
      );
      return result.rows.map((row: unknown) => toEntity(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }
}

export class PostgresEntityAliasRepository implements EntityAliasRepository {
  async add(scope: TenantScope, alias: NewEntityAlias): Promise<EntityAlias> {
    const value = normaliseAliasValue(alias.kind, alias.value);
    try {
      const client = clientOf(scope);
      const existing = await client.query(
        `SELECT ${ALIAS_COLUMNS} FROM public.entity_aliases
          WHERE organization_id = $1 AND kind = $2 AND value = $3`,
        [scope.tenantId, alias.kind, value],
      );
      const found: unknown = existing.rows[0];
      if (found !== undefined) {
        const current = toAlias(found);
        if (current.entityId === alias.entityId) return current;
      }
      const result = await client.query(
        `INSERT INTO public.entity_aliases (organization_id, entity_id, kind, value, display)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${ALIAS_COLUMNS}`,
        [scope.tenantId, alias.entityId, alias.kind, value, alias.value.trim()],
      );
      return toAlias(result.rows[0]);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async findByValue(
    scope: TenantScope,
    kind: EntityAliasKind,
    value: string,
  ): Promise<EntityAlias[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${ALIAS_COLUMNS} FROM public.entity_aliases
          WHERE organization_id = $1 AND kind = $2 AND value = $3`,
        [scope.tenantId, kind, value],
      );
      return result.rows.map((row: unknown) => toAlias(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async listForEntity(scope: Scope, entityId: EntityId): Promise<EntityAlias[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${ALIAS_COLUMNS} FROM public.entity_aliases WHERE entity_id = $1 ORDER BY kind, value`,
        [entityId],
      );
      return result.rows.map((row: unknown) => toAlias(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async similarNames(
    scope: TenantScope,
    entityKind: EntityKind,
    nameKey: string,
    limit: number,
  ): Promise<SimilarName[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT a.entity_id, a.display,
                GREATEST(similarity(a.value, $3), word_similarity($3, a.value)) AS similarity
           FROM public.entity_aliases a
           JOIN public.entities e ON e.id = a.entity_id
          WHERE a.organization_id = $1 AND a.kind = 'name' AND e.kind = $2
            AND GREATEST(similarity(a.value, $3), word_similarity($3, a.value)) > 0
          ORDER BY similarity DESC, a.value
          LIMIT $4`,
        [scope.tenantId, entityKind, nameKey, Math.min(Math.max(limit, 1), 50)],
      );
      return result.rows.map((raw: unknown) => {
        const parsed = SimilarRowSchema.safeParse(raw);
        if (!parsed.success) {
          throw new InternalError(
            'ROW_SHAPE_MISMATCH',
            'A similarity row did not match its schema.',
            {
              cause: validationErrorFromZod(parsed.error),
            },
          );
        }
        return {
          entityId: parsed.data.entity_id,
          value: parsed.data.display,
          similarity: parsed.data.similarity,
        };
      });
    } catch (error) {
      throw translatePgError(error);
    }
  }
}
