import pg from 'pg';

import type { Logger } from '../../kernel/logger.js';

const { Pool } = pg;

export interface PostgresPoolOptions {
  readonly connectionString: string;
  readonly max: number;
  readonly applicationName: string;
  readonly logger: Logger;
  /** Per-statement timeout; protects the pool from runaway queries. */
  readonly statementTimeoutMs?: number;
}

/**
 * Creates a connection pool. The connection string is a secret revealed only
 * here by the composition root; it is never logged.
 */
export function createPostgresPool(options: PostgresPoolOptions): pg.Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (error: Error) => {
    options.logger.error('postgres pool error', { error: error.message });
  });
  return pool;
}
