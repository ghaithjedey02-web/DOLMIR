import { z } from 'zod';

import type { Actor } from '../../../kernel/context.js';
import { type DomainError, validationErrorFromZod } from '../../../kernel/errors.js';
import type { OrganizationId } from '../../../kernel/ids.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import type { TenantScope, TransactionRunner } from '../../../kernel/scope.js';
import type { AuditRecorder } from '../../audit/index.js';
import {
  type Entity,
  type EntityAliasKind,
  EntityKindSchema,
  emailDomain,
  isPublicEmailDomain,
  normaliseAliasValue,
} from '../domain/entity.js';
import type { EntityAliasRepository, EntityRepository } from './ports.js';

/**
 * Imports or refreshes entities from the company's own records (an ERP
 * export, a CSV). Upserts by code when present, otherwise by normalised name;
 * every handle becomes an alias. Deterministic, audited, idempotent.
 */
export const ImportEntityRowSchema = z
  .object({
    kind: EntityKindSchema,
    name: z.string().trim().min(1).max(300),
    code: z.string().trim().min(1).max(100).optional(),
    email: z.email().trim().max(320).optional(),
    domain: z.string().trim().min(1).max(253).optional(),
    vat: z.string().trim().min(1).max(50).optional(),
    attributes: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type ImportEntityRow = z.input<typeof ImportEntityRowSchema>;

export const ImportEntitiesInputSchema = z
  .object({
    rows: z.array(ImportEntityRowSchema).min(1).max(5000),
    /** Where the rows came from — recorded in the audit entry. */
    source: z.string().trim().min(1).max(200),
  })
  .strict();
export type ImportEntitiesInput = z.input<typeof ImportEntitiesInputSchema>;

export interface ImportEntitiesReport {
  readonly created: number;
  readonly updated: number;
  readonly aliasesAdded: number;
  readonly entities: readonly Entity[];
}

export interface ImportEntitiesDependencies {
  readonly transactions: TransactionRunner;
  readonly entities: EntityRepository;
  readonly aliases: EntityAliasRepository;
  readonly audit: AuditRecorder;
}

export class ImportEntities {
  private readonly deps: ImportEntitiesDependencies;

  constructor(deps: ImportEntitiesDependencies) {
    this.deps = deps;
  }

  async execute(
    tenantId: OrganizationId,
    actor: Actor,
    rawInput: ImportEntitiesInput,
  ): Promise<Result<ImportEntitiesReport, DomainError>> {
    const parsed = ImportEntitiesInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return err(
        validationErrorFromZod(
          parsed.error,
          'INVALID_ENTITY_IMPORT',
          'The import rows are invalid.',
        ),
      );
    }
    const input = parsed.data;
    return this.deps.transactions.withTenant(tenantId, async (scope) => {
      let created = 0;
      let updated = 0;
      let aliasesAdded = 0;
      const entities: Entity[] = [];
      for (const row of input.rows) {
        const existing = await this.findExisting(scope, row.kind, row.code, row.name);
        let entity: Entity;
        if (existing === undefined) {
          entity = await this.deps.entities.insert(scope, {
            organizationId: tenantId,
            kind: row.kind,
            name: row.name,
            code: row.code ?? null,
            attributes: row.attributes,
          });
          created += 1;
        } else {
          entity =
            (await this.deps.entities.update(scope, existing.id, {
              name: row.name,
              ...(row.code === undefined ? {} : { code: row.code }),
              attributes: { ...existing.attributes, ...row.attributes },
            })) ?? existing;
          updated += 1;
        }
        entities.push(entity);
        const handles: { kind: EntityAliasKind; value: string | undefined }[] = [
          { kind: 'name', value: row.name },
          { kind: 'code', value: row.code },
          { kind: 'email', value: row.email },
          { kind: 'vat', value: row.vat },
          {
            kind: 'email_domain',
            value: row.domain ?? (row.email === undefined ? undefined : emailDomain(row.email)),
          },
        ];
        for (const handle of handles) {
          if (handle.value === undefined) continue;
          if (handle.kind === 'email_domain' && isPublicEmailDomain(handle.value)) continue;
          const before = await this.deps.aliases.findByValue(
            scope,
            handle.kind,
            normaliseAliasValue(handle.kind, handle.value),
          );
          if (before.some((alias) => alias.entityId === entity.id)) continue;
          await this.deps.aliases.add(scope, {
            entityId: entity.id,
            kind: handle.kind,
            value: handle.value,
          });
          aliasesAdded += 1;
        }
      }
      await this.deps.audit.record(scope, {
        organizationId: tenantId,
        actor,
        action: 'entities.imported',
        details: { source: input.source, rows: input.rows.length, created, updated, aliasesAdded },
      });
      return ok({ created, updated, aliasesAdded, entities });
    });
  }

  private async findExisting(
    scope: TenantScope,
    kind: Entity['kind'],
    code: string | undefined,
    name: string,
  ): Promise<Entity | undefined> {
    const lookups: { kind: EntityAliasKind; value: string }[] = [];
    if (code !== undefined)
      lookups.push({ kind: 'code', value: normaliseAliasValue('code', code) });
    lookups.push({ kind: 'name', value: normaliseAliasValue('name', name) });
    for (const lookup of lookups) {
      const aliases = await this.deps.aliases.findByValue(scope, lookup.kind, lookup.value);
      const ids = aliases.map((alias) => alias.entityId);
      if (ids.length === 0) continue;
      const candidates = await this.deps.entities.findByIds(scope, ids);
      const match = candidates.find((entity) => entity.kind === kind);
      if (match !== undefined) return match;
    }
    return undefined;
  }
}
