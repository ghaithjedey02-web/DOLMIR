import { afterEach, describe, expect, it } from 'vitest';

import {
  type Config,
  InMemoryJobQueue,
  PgBossJobQueue,
  isDomainError,
  loadConfig,
  noopLogger,
} from '@dolmir/core';

import { type Container, createContainer } from './container.js';
import { PLATFORM_JOBS } from './jobs.js';

/**
 * The background runtime's lifecycle, without a database.
 *
 * Every assertion here is about real behaviour of the real container: which
 * queue adapter a configuration produces, which handlers `start()` actually
 * registers, and what happens when it is started twice, stopped, or closed
 * twice. Nothing is mocked — the port that is exercised is the in-memory
 * adapter, and the same registrations against pg-boss and a real PostgreSQL
 * are proved in `tests/integration/job-runtime.test.ts` and
 * `tests/e2e/runtime-lifecycle.test.ts`.
 *
 * The database URL points at a closed port on purpose: the startup recovery
 * sweep is best-effort, and one of the things worth proving is that a
 * database it cannot reach does not stop the runtime from starting.
 */
const base = {
  DOLMIR_DATABASE_URL: 'postgres://dolmir_app:pw@127.0.0.1:1/dolmir',
  DOLMIR_AUTH_ISSUER: 'http://localhost/dev-auth',
  DOLMIR_AUTH_AUDIENCE: 'dolmir',
  DOLMIR_AUTH_HS256_SECRET: 'test-only-secret-value-at-least-32-chars',
};

function configure(overrides: Record<string, string> = {}): Config {
  const result = loadConfig({ ...base, ...overrides });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const productionEnv = {
  DOLMIR_ENV: 'production',
  DOLMIR_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
  DOLMIR_JOBS_DRIVER: 'pg-boss',
  DOLMIR_STORAGE_DRIVER: 'local',
  DOLMIR_STORAGE_LOCAL_ROOT: '/var/lib/dolmir/objects',
  DOLMIR_AI_PROVIDER: 'anthropic',
  // A placeholder the SDK client is built with and nothing ever sends: no
  // test here reaches the network.
  DOLMIR_AI_ANTHROPIC_API_KEY: 'sk-ant-test-placeholder-never-sent',
};

let open: Container | undefined;
const container = (config: Config): Container => {
  open = createContainer(config, { logger: noopLogger });
  return open;
};

afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe('the queue a configuration produces', () => {
  it('is pg-boss when the deployment is configured for production', () => {
    const production = container(configure(productionEnv));
    expect(production.jobs.queue).toBeInstanceOf(PgBossJobQueue);
  });

  it('is the in-memory queue only outside production', () => {
    expect(container(configure()).jobs.queue).toBeInstanceOf(InMemoryJobQueue);
  });

  it('cannot be the in-memory queue in production, because configuration refuses to load', () => {
    // The runtime never has to decide this: work that only exists in one
    // process's memory is lost on restart, so the loader will not produce a
    // production configuration that asks for it.
    const memory = loadConfig({ ...base, ...productionEnv, DOLMIR_JOBS_DRIVER: 'memory' });
    expect(memory.ok).toBe(false);
    if (!memory.ok) expect(memory.error.message).toContain('DOLMIR_JOBS_DRIVER');

    const omitted = loadConfig({ ...base, ...productionEnv, DOLMIR_JOBS_DRIVER: '' });
    expect(omitted.ok).toBe(false);
  });
});

describe('starting the background runtime', () => {
  it('registers a worker for every job this deployment ships, and no others', async () => {
    const c = container(configure());
    expect(c.jobs.registered()).toEqual([]);

    await c.jobs.start();

    expect(c.jobs.registered()).toEqual(PLATFORM_JOBS.map((job) => job.name));
    expect(c.jobs.registered()).toContain('cases.execute_recommendation');
    expect(c.jobs.registered()).toContain('cases.recover_executions');
  });

  it('schedules recovery, and schedules nothing else', async () => {
    const c = container(configure());
    await c.jobs.start();
    const queue = c.jobs.queue as InMemoryJobQueue;
    expect(queue.schedules.map((s) => s.name)).toEqual(['cases.recover_executions']);
    // Mailbox polling has a worker and deliberately no schedule: DOLMIR does
    // not read a company's mailbox on its own.
    expect(queue.schedules.map((s) => s.name)).not.toContain('mailbox.poll');
  });

  it('starts even though the startup recovery sweep cannot reach the database', async () => {
    // The sweep is an optimisation over the every-five-minutes schedule. A
    // database that is briefly away delays recovery; it must not stop a boot.
    const c = container(configure());
    await expect(c.jobs.start()).resolves.toBeUndefined();
    expect(c.jobs.registered()).toHaveLength(PLATFORM_JOBS.length);
  });

  it('is idempotent: starting twice registers one worker per job', async () => {
    const c = container(configure());
    await c.jobs.start();
    await c.jobs.start();
    expect(c.jobs.registered()).toEqual(PLATFORM_JOBS.map((job) => job.name));
    expect((c.jobs.queue as InMemoryJobQueue).schedules).toHaveLength(1);
  });

  it('refuses to restart after a shutdown rather than register a second handler', async () => {
    const c = container(configure());
    await c.jobs.start();
    await c.jobs.stop();
    expect(c.jobs.registered()).toEqual([]);
    await expect(c.jobs.start()).rejects.toSatisfy(
      (error: unknown) => isDomainError(error) && error.code === 'JOB_RUNTIME_STOPPED',
    );
  });
});

describe('shutting down', () => {
  it('stops the workers and releases the pool, and does both once', async () => {
    const c = container(configure());
    await c.jobs.start();

    await c.close();
    await c.close();

    expect(c.jobs.registered()).toEqual([]);
    expect(c.pool.ended).toBe(true);
    open = undefined;
  });

  it('is safe when the runtime never started', async () => {
    const c = container(configure());
    await expect(c.close()).resolves.toBeUndefined();
    open = undefined;
  });
});

describe('readiness', () => {
  it('reports whether this process is working the queue, and with which adapter', async () => {
    const c = container(configure());

    const before = await c.readiness();
    expect(before.checks.jobs).toEqual({ status: 'not_running', driver: 'memory' });

    await c.jobs.start();
    const after = await c.readiness();
    expect(after.checks.jobs).toEqual({ status: 'running', driver: 'memory' });

    // The database is unreachable in this test, and readiness says so rather
    // than letting the jobs check make the process look healthy.
    expect(after.status).toBe('not_ready');
  });
});
