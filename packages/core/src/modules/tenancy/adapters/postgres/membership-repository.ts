import type { OrganizationId, UserId } from '../../../../kernel/ids.js';
import type { Scope } from '../../../../kernel/scope.js';
import { translatePgError } from '../../../../infrastructure/postgres/errors.js';
import { clientOf } from '../../../../infrastructure/postgres/transaction-runner.js';
import type { MembershipRepository } from '../../application/ports.js';
import type { Membership, NewMembership } from '../../domain/membership.js';
import { MembershipRowSchema, parseRow, toMembership } from './rows.js';

const COLUMNS = 'organization_id, user_id, role_key, status, created_at, updated_at';

export class PostgresMembershipRepository implements MembershipRepository {
  async find(
    scope: Scope,
    organizationId: OrganizationId,
    userId: UserId,
  ): Promise<Membership | undefined> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${COLUMNS} FROM public.memberships WHERE organization_id = $1 AND user_id = $2`,
        [organizationId, userId],
      );
      const row: unknown = result.rows[0];
      return row === undefined
        ? undefined
        : toMembership(parseRow(MembershipRowSchema, row, 'memberships'));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async listForUser(scope: Scope, userId: UserId): Promise<Membership[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${COLUMNS} FROM public.memberships WHERE user_id = $1 ORDER BY created_at`,
        [userId],
      );
      return result.rows.map((row: unknown) =>
        toMembership(parseRow(MembershipRowSchema, row, 'memberships')),
      );
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async insert(scope: Scope, membership: NewMembership): Promise<Membership> {
    try {
      const result = await clientOf(scope).query(
        `INSERT INTO public.memberships (organization_id, user_id, role_key)
         VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
        [membership.organizationId, membership.userId, membership.roleKey],
      );
      return toMembership(parseRow(MembershipRowSchema, result.rows[0], 'memberships'));
    } catch (error) {
      throw translatePgError(error);
    }
  }
}
