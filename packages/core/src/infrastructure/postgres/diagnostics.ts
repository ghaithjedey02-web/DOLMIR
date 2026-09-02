import type pg from 'pg';

import { type DomainError } from '../../kernel/errors.js';
import { err, ok, type Result } from '../../kernel/result.js';
import { translatePgError } from './errors.js';

/**
 * What `doctor` and the readiness endpoint need to know about the runtime
 * connection: reachable, which role, and whether that role could ever bypass
 * Row-Level Security (it must not — ADR-0005).
 */
export interface DatabaseDiagnostics {
  readonly latencyMs: number;
  readonly serverVersion: string;
  readonly currentUser: string;
  readonly bypassesRls: boolean;
  readonly superuser: boolean;
}

export async function diagnoseDatabase(
  pool: pg.Pool,
): Promise<Result<DatabaseDiagnostics, DomainError>> {
  const started = performance.now();
  try {
    const result = await pool.query<{
      server_version: string;
      current_user: string;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      `SELECT current_setting('server_version') AS server_version,
              current_user,
              r.rolbypassrls,
              r.rolsuper
         FROM pg_roles r
        WHERE r.rolname = current_user`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      return err(translatePgError(new Error('pg_roles returned no row for current_user')));
    }
    return ok({
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      serverVersion: row.server_version,
      currentUser: row.current_user,
      bypassesRls: row.rolbypassrls,
      superuser: row.rolsuper,
    });
  } catch (error) {
    return err(translatePgError(error));
  }
}
