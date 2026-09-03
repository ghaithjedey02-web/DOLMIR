import { type Db, PgBoss } from 'pg-boss';

import { InfrastructureError } from '../../kernel/errors.js';
import {
  type EnqueueOptions,
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
    'name' | 'retryLimit' | 'retryDelaySeconds' | 'expireInSeconds'
  >[];
  readonly logger?: Logger;
}

export interface JobQueueInstallReport {
  readonly schema: string;
  readonly schemaVersion: number | null;
  readonly queuesCreated: readonly string[];
  readonly queuesUpdated: readonly string[];
}

/** Deploy-time installation with the owner connection (`dolmir jobs:migrate`). */
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
      const existing = await boss.getQueue(job.name);
      if (existing === null) {
        await boss.createQueue(job.name, queueOptions);
        queuesCreated.push(job.name);
      } else {
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
