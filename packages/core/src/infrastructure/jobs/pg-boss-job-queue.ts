import { type Db, PgBoss } from 'pg-boss';

import { InfrastructureError } from '../../kernel/errors.js';
import {
  type EnqueueOptions,
  JobConcurrency,
  type JobDefinition,
  type JobHandler,
  type JobName,
  type JobQueuePort,
  type JobRef,
  type ScheduleOptions,
  parseJobPayload,
} from '../../kernel/jobs.js';
import { type Logger, noopLogger } from '../../kernel/logger.js';

/**
 * pg-boss behind the queue port (ADR-0014). Two roles, two entry points:
 *
 *   installJobQueue()  — owner connection, deploy time: creates or migrates the
 *                        pg-boss schema, creates the queues (a queue is a table
 *                        partition, so only the owner may create one) and grants
 *                        the runtime role what it needs inside that schema.
 *   PgBossJobQueue     — runtime role: never migrates, never creates queues.
 *
 * The runtime role holds DELETE inside the jobs schema (pg-boss maintenance
 * removes finished jobs); tenant data in `public` stays DELETE-free (ADR-0005).
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export interface PgBossJobQueueOptions {
  readonly connectionString: string;
  readonly schema: string;
  readonly logger?: Logger;
  readonly applicationName?: string;
  /** Connections pg-boss may open; small, the API pool is separate. */
  readonly max?: number;
}

export class PgBossJobQueue implements JobQueuePort {
  private readonly boss: PgBoss;
  private readonly logger: Logger;
  private started = false;

  constructor(options: PgBossJobQueueOptions) {
    assertIdentifier(options.schema, 'schema');
    this.logger = options.logger ?? noopLogger;
    this.boss = new PgBoss({
      connectionString: options.connectionString,
      schema: options.schema,
      application_name: options.applicationName ?? 'dolmir-jobs',
      max: options.max ?? 4,
      migrate: false,
      createSchema: false,
      supervise: true,
      schedule: true,
    });
    this.boss.on('error', (error) => {
      this.logger.error('job queue error', { error: describeError(error) });
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    try {
      await this.boss.start();
    } catch (error) {
      throw new InfrastructureError('JOB_QUEUE_UNAVAILABLE', 'The job queue could not start.', {
        cause: error,
        retryable: true,
        details: { reason: describeError(error) },
      });
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.boss.stop({ graceful: true, timeout: 10_000 });
    this.started = false;
  }

  async enqueue<T extends object>(
    job: JobDefinition<T>,
    payload: T,
    options: EnqueueOptions = {},
  ): Promise<JobRef> {
    const validated = parseJobPayload(job, payload);
    try {
      const id = await this.boss.send(job.name, validated, {
        ...(options.idempotencyKey === undefined ? {} : { singletonKey: options.idempotencyKey }),
        ...(options.delaySeconds === undefined ? {} : { startAfter: options.delaySeconds }),
        retryLimit: options.retryLimit ?? job.retryLimit,
        retryDelay: job.retryDelaySeconds,
        retryBackoff: true,
        expireInSeconds: job.expireInSeconds,
      });
      return { id, name: job.name, deduplicated: id === null };
    } catch (error) {
      throw new InfrastructureError(
        'JOB_ENQUEUE_FAILED',
        `Job ${job.name} could not be enqueued.`,
        {
          cause: error,
          retryable: true,
          details: { job: job.name, reason: describeError(error) },
        },
      );
    }
  }

  async work<T extends object>(job: JobDefinition<T>, handler: JobHandler<T>): Promise<void> {
    // No explicit type argument: `includeMetadata: true` must be inferred as a
    // literal for pg-boss to hand the handler jobs carrying `retryCount`.
    await this.boss.work(
      job.name,
      { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: 2 },
      async (jobs) => {
        for (const item of jobs) {
          const payload = parseJobPayload(job, item.data);
          await handler(payload, { id: item.id, name: job.name, attempt: item.retryCount + 1 });
        }
      },
    );
  }

  async schedule<T extends object>(
    job: JobDefinition<T>,
    cron: string,
    payload: T,
    options: ScheduleOptions = {},
  ): Promise<void> {
    const validated = parseJobPayload(job, payload);
    await this.boss.schedule(job.name, cron, validated, {
      ...(options.tz === undefined ? {} : { tz: options.tz }),
      ...(options.key === undefined ? {} : { key: options.key }),
      retryLimit: job.retryLimit,
      retryDelay: job.retryDelaySeconds,
      retryBackoff: true,
      expireInSeconds: job.expireInSeconds,
    });
  }

  async unschedule(job: { readonly name: JobName }, key?: string): Promise<void> {
    await this.boss.unschedule(job.name, key);
  }
}

export interface JobQueueInstallOptions {
  readonly ownerConnectionString: string;
  readonly schema: string;
  /** The runtime role (`dolmir_app`) that will enqueue and work jobs. */
  readonly runtimeRole: string;
  readonly jobs: readonly Pick<
    JobDefinition<object>,
    'name' | 'retryLimit' | 'retryDelaySeconds' | 'expireInSeconds' | 'concurrency'
  >[];
  readonly logger?: Logger;
}

export interface JobQueueInstallReport {
  readonly schema: string;
  readonly schemaVersion: number | null;
  readonly queuesCreated: readonly string[];
  readonly queuesUpdated: readonly string[];
}

/** Deploy-time installation with the owner connection (`dolmir jobs:install`). */
export async function installJobQueue(
  options: JobQueueInstallOptions,
): Promise<JobQueueInstallReport> {
  assertIdentifier(options.schema, 'schema');
  assertIdentifier(options.runtimeRole, 'runtime role');
  const logger = options.logger ?? noopLogger;
  const boss = new PgBoss({
    connectionString: options.ownerConnectionString,
    schema: options.schema,
    application_name: 'dolmir-jobs-install',
    max: 2,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
  });
  boss.on('error', (error) => {
    logger.error('job queue installation error', { error: describeError(error) });
  });
  await boss.start();
  try {
    const queuesCreated: string[] = [];
    const queuesUpdated: string[] = [];
    for (const job of options.jobs) {
      const queueOptions = {
        retryLimit: job.retryLimit,
        retryDelay: job.retryDelaySeconds,
        retryBackoff: true,
        expireInSeconds: job.expireInSeconds,
      };
      const policy = policyFor(job.concurrency);
      const existing = await boss.getQueue(job.name);
      if (existing === null) {
        await boss.createQueue(job.name, { ...queueOptions, policy });
        queuesCreated.push(job.name);
      } else {
        // pg-boss fixes a queue's policy at creation: `updateQueue` cannot
        // change it. Saying nothing here would leave a queue that silently
        // accepts the duplicates its jobs declared it must not, so this stops
        // the install instead. The remedy is to drain and drop the queue.
        if (existing.policy !== policy) {
          throw new InfrastructureError(
            'JOB_QUEUE_POLICY_MISMATCH',
            `Queue ${job.name} exists with policy "${String(existing.policy)}" but must be "${policy}"; drop it once it is drained and install again.`,
            { details: { job: job.name, found: existing.policy ?? null, expected: policy } },
          );
        }
        await boss.updateQueue(job.name, queueOptions);
        queuesUpdated.push(job.name);
      }
    }
    await grantRuntimeAccess(boss.getDb(), options.schema, options.runtimeRole);
    const schemaVersion = await boss.schemaVersion();
    logger.info('job queue installed', {
      schema: options.schema,
      schemaVersion,
      queuesCreated,
      queuesUpdated,
    });
    return { schema: options.schema, schemaVersion, queuesCreated, queuesUpdated };
  } finally {
    await boss.stop({ graceful: true, timeout: 5_000 });
  }
}

/** Anything that runs a parameterised query: a `pg.Pool` or a `pg.Client`. */
export interface SqlQueryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

export interface JobQueueInspection {
  readonly schema: string;
  readonly schemaPresent: boolean;
  /** One entry per job the deployment ships, present in the database or not. */
  readonly queues: readonly {
    readonly name: string;
    readonly present: boolean;
    readonly policy: string | null;
    readonly expectedPolicy: string;
    /** Present, and on the policy its job's concurrency requires. */
    readonly ok: boolean;
  }[];
  /** What pg-boss will enqueue on its own. Empty schema → empty list. */
  readonly schedules: readonly {
    readonly name: string;
    readonly key: string;
    readonly cron: string;
    readonly timezone: string | null;
  }[];
}

/**
 * Reads what `installJobQueue` should have left behind, and changes nothing.
 *
 * Runs with the runtime connection (it has SELECT on the jobs schema) so an
 * operator can ask a deployment "would your workers have queues to work?"
 * before it starts — or "what will the queue do on its own?" afterwards — with
 * no owner credentials and no side effects. A missing schema is an answer,
 * not an error: every queue is reported absent.
 */
export async function inspectJobQueue(
  db: SqlQueryable,
  options: {
    readonly schema: string;
    readonly jobs: readonly Pick<JobDefinition<object>, 'name' | 'concurrency'>[];
  },
): Promise<JobQueueInspection> {
  assertIdentifier(options.schema, 'schema');
  const { schema } = options;

  const namespace = await db.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
  const schemaPresent = namespace.rows.length > 0;

  const policies = new Map<string, string | null>();
  const schedules: JobQueueInspection['schedules'][number][] = [];
  if (schemaPresent) {
    // The identifier was validated above; it is never user input at runtime.
    const queues = await db.query(`SELECT name, policy FROM ${schema}.queue`);
    for (const row of queues.rows as { name: string; policy: string | null }[]) {
      policies.set(row.name, row.policy);
    }
    const scheduled = await db.query(
      `SELECT name, key, cron, timezone FROM ${schema}.schedule ORDER BY name, key`,
    );
    for (const row of scheduled.rows as {
      name: string;
      key: string;
      cron: string;
      timezone: string | null;
    }[]) {
      schedules.push({ name: row.name, key: row.key, cron: row.cron, timezone: row.timezone });
    }
  }

  return {
    schema,
    schemaPresent,
    queues: options.jobs.map((job) => {
      const present = policies.has(job.name);
      const policy = policies.get(job.name) ?? null;
      const expectedPolicy = policyFor(job.concurrency);
      return {
        name: job.name,
        present,
        policy,
        expectedPolicy,
        ok: present && policy === expectedPolicy,
      };
    }),
    schedules,
  };
}

/**
 * DOLMIR's concurrency vocabulary in pg-boss's.
 *
 * `exclusive` is "one job queued or active", extended by `singletonKey` when
 * one is given — which is exactly what `ONE_AT_A_TIME` promises. The default
 * `standard` policy holds any number of identical jobs, so a queue left on it
 * would accept a second execution of a recommendation that is already being
 * carried out. That is safe (the entitlement row is locked and the second
 * attempt does nothing) but it is not what the port says, and a promise the
 * adapter does not keep is worse than no promise.
 */
function policyFor(concurrency: JobConcurrency): 'standard' | 'exclusive' {
  return concurrency === JobConcurrency.ONE_AT_A_TIME ? 'exclusive' : 'standard';
}

async function grantRuntimeAccess(db: Db, schema: string, role: string): Promise<void> {
  // Both identifiers were validated against IDENTIFIER above; they are never user input.
  const statements = [
    `GRANT USAGE ON SCHEMA ${schema} TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${role}`,
  ];
  for (const statement of statements) {
    await db.executeSql(statement);
  }
}

/**
 * The role the runtime will connect as, read from the runtime connection URL.
 *
 * Installation needs two connections that are deliberately different: the
 * owner creates the schema and the queues, and the runtime role is granted
 * what it needs inside them. Rather than ask an operator to name that role a
 * second time — and get it wrong — it is taken from the connection the runtime
 * itself uses. The result must be a plain lowercase identifier, which is also
 * what makes it safe to interpolate into a GRANT.
 */
export function runtimeRoleFromConnectionString(connectionString: string): string {
  let username: string;
  try {
    username = decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new InfrastructureError(
      'INVALID_JOBS_RUNTIME_ROLE',
      'The runtime database URL could not be parsed, so the role to grant is unknown.',
    );
  }
  if (username === '') {
    throw new InfrastructureError(
      'INVALID_JOBS_RUNTIME_ROLE',
      'The runtime database URL carries no user, so the role to grant is unknown.',
    );
  }
  assertIdentifier(username, 'runtime role');
  return username;
}

function assertIdentifier(value: string, what: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new InfrastructureError(
      'INVALID_JOBS_IDENTIFIER',
      `The jobs ${what} must be a lowercase SQL identifier.`,
      { details: { value } },
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
