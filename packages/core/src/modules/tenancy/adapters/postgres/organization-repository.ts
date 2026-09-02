import type { OrganizationId } from '../../../../kernel/ids.js';
import type { Scope } from '../../../../kernel/scope.js';
import { translatePgError } from '../../../../infrastructure/postgres/errors.js';
import { clientOf } from '../../../../infrastructure/postgres/transaction-runner.js';
import type { OrganizationRepository } from '../../application/ports.js';
import type { NewOrganization, Organization } from '../../domain/organization.js';
import { OrganizationRowSchema, parseRow, toOrganization } from './rows.js';

const COLUMNS = 'id, slug, name, status, created_at, updated_at';

export class PostgresOrganizationRepository implements OrganizationRepository {
  async findById(scope: Scope, id: OrganizationId): Promise<Organization | undefined> {
    return this.one(scope, `SELECT ${COLUMNS} FROM public.organizations WHERE id = $1`, [id]);
  }

  async findBySlug(scope: Scope, slug: string): Promise<Organization | undefined> {
    return this.one(scope, `SELECT ${COLUMNS} FROM public.organizations WHERE slug = $1`, [slug]);
  }

  async insert(scope: Scope, organization: NewOrganization): Promise<Organization> {
    try {
      const result = await clientOf(scope).query(
        `INSERT INTO public.organizations (slug, name) VALUES ($1, $2) RETURNING ${COLUMNS}`,
        [organization.slug, organization.name],
      );
      return toOrganization(parseRow(OrganizationRowSchema, result.rows[0], 'organizations'));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  private async one(
    scope: Scope,
    sql: string,
    values: unknown[],
  ): Promise<Organization | undefined> {
    try {
      const result = await clientOf(scope).query(sql, values);
      const row: unknown = result.rows[0];
      return row === undefined
        ? undefined
        : toOrganization(parseRow(OrganizationRowSchema, row, 'organizations'));
    } catch (error) {
      throw translatePgError(error);
    }
  }
}
