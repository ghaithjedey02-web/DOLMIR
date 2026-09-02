import type pg from 'pg';

import { InternalError } from '../../kernel/errors.js';
import type { OrganizationId } from '../../kernel/ids.js';
import type { Logger } from '../../kernel/logger.js';
import type { Scope, SystemScope, TenantScope, TransactionRunner } from '../../kernel/scope.js';
import { translatePgError } from './errors.js';

/**
 * The PostgreSQL `TransactionRunner` (ADR-0005).
 *
 * Every unit of work is a transaction on one pooled connection. Tenant scope
 * sets `dolmir.tenant_id` and `dolmir.scope = 'tenant'` transaction-locally;
 * system scope sets `dolmir.scope = 'system'`. Row-Level Security policies read
 * those settings, so a query outside any scope sees nothing and writes nothing.
 * The settings die with the transaction, which keeps pooled connections clean.
 */

const CLIENT = Symbol('dolmir.postgres.client');

interface PostgresScopeHandle {
  readonly [CLIENT]: pg.PoolClient;
}

export type PostgresTenantScope = TenantScope & PostgresScopeHandle;
export type PostgresSystemScope = SystemScope & PostgresScopeHandle;

/** Adapters obtain the connection bound to a scope; any other scope is a wiring error. */
export function clientOf(scope: Scope): pg.PoolClient {
  const client = (scope as Partial<PostgresScopeHandle>)[CLIENT];
  if (client === undefined) {
    throw new InternalError(
      'SCOPE_NOT_POSTGRES',
      'This repository requires a scope created by the PostgreSQL transaction runner.',
    );
  }
  return client;
}

export interface PostgresTransactionRunnerOptions {
  /**
   * Invoked inside every system-scope transaction before the caller's work,
   * so the composition root can leave an audit entry for the privileged path
   * in the same transaction (the runner itself cannot depend on the audit
   * module).
   */
  readonly onSystemScopeOpened?: (scope: SystemScope) => Promise<void>;
}

export class PostgresTransactionRunner implements TransactionRunner {
  private readonly pool: pg.Pool;
  private readonly logger: Logger;
  private readonly options: PostgresTransactionRunnerOptions;

  constructor(pool: pg.Pool, logger: Logger, options: PostgresTransactionRunnerOptions = {}) {
    this.pool = pool;
    this.logger = logger;
    this.options = options;
  }

  async withTenant<T>(
    tenantId: OrganizationId,
    fn: (scope: TenantScope) => Promise<T>,
  ): Promise<T> {
    return this.run(
      async (client) => {
        await client.query(
          "SELECT set_config('dolmir.tenant_id', $1, true), set_config('dolmir.scope', 'tenant', true)",
          [tenantId],
        );
      },
      (client): PostgresTenantScope => ({ kind: 'tenant', tenantId, [CLIENT]: client }),
      fn,
    );
  }

  async withSystemScope<T>(reason: string, fn: (scope: SystemScope) => Promise<T>): Promise<T> {
    if (reason.trim().length === 0) {
      throw new InternalError('SYSTEM_SCOPE_REASON_REQUIRED', 'System scope requires a reason.');
    }
    this.logger.info('system scope opened', { reason });
    return this.run(
      async (client) => {
        await client.query("SELECT set_config('dolmir.scope', 'system', true)", []);
      },
      (client): PostgresSystemScope => ({ kind: 'system', reason, [CLIENT]: client }),
      async (scope) => {
        if (this.options.onSystemScopeOpened !== undefined) {
          await this.options.onSystemScopeOpened(scope);
        }
        return fn(scope);
      },
    );
  }

  private async run<S extends Scope, T>(
    prepare: (client: pg.PoolClient) => Promise<void>,
    scopeOf: (client: pg.PoolClient) => S,
    fn: (scope: S) => Promise<T>,
  ): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw translatePgError(error);
    }
    try {
      await client.query('BEGIN');
      await prepare(client);
      const result = await fn(scopeOf(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        this.logger.error('rollback failed', {
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      throw translatePgError(error);
    } finally {
      client.release();
    }
  }
}
