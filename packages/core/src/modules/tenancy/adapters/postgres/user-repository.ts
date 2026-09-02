import type { UserId } from '../../../../kernel/ids.js';
import type { Scope } from '../../../../kernel/scope.js';
import { translatePgError } from '../../../../infrastructure/postgres/errors.js';
import { clientOf } from '../../../../infrastructure/postgres/transaction-runner.js';
import type { UserRepository } from '../../application/ports.js';
import type { NewUser, User } from '../../domain/user.js';
import { UserRowSchema, parseRow, toUser } from './rows.js';

const COLUMNS = 'id, auth_subject, email::text AS email, display_name, created_at, updated_at';

export class PostgresUserRepository implements UserRepository {
  async findById(scope: Scope, id: UserId): Promise<User | undefined> {
    return this.one(scope, `SELECT ${COLUMNS} FROM public.users WHERE id = $1`, [id]);
  }

  async findByAuthSubject(scope: Scope, authSubject: string): Promise<User | undefined> {
    return this.one(scope, `SELECT ${COLUMNS} FROM public.users WHERE auth_subject = $1`, [
      authSubject,
    ]);
  }

  async insert(scope: Scope, user: NewUser): Promise<User> {
    try {
      const result = await clientOf(scope).query(
        `INSERT INTO public.users (auth_subject, email, display_name)
         VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
        [user.authSubject, user.email, user.displayName],
      );
      return toUser(parseRow(UserRowSchema, result.rows[0], 'users'));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  private async one(scope: Scope, sql: string, values: unknown[]): Promise<User | undefined> {
    try {
      const result = await clientOf(scope).query(sql, values);
      const row: unknown = result.rows[0];
      return row === undefined ? undefined : toUser(parseRow(UserRowSchema, row, 'users'));
    } catch (error) {
      throw translatePgError(error);
    }
  }
}
