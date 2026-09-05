import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installJobQueue, noopLogger } from '@dolmir/core';
import { PLATFORM_JOBS } from '@dolmir/api';

import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

/**
 * The real process, started the way a deployment starts it.
 *
 * Every other test in this repository imports the code. This one runs
 * `apps/api/src/main.ts` as a child process with a production configuration
 * against a real database and a real pg-boss queue, and then asks the two
 * questions that no import-level test can answer:
 *
 *   does a DOLMIR process that is serving HTTP also work the queue, and
 *   does SIGTERM stop both cleanly?
 *
 * Before this existed the answer to the first was no. `container.jobs.start()`
 * had exactly one caller in the repository and it was an end-to-end test, so
 * every approval in production would have committed an entitlement that no
 * worker was running to carry out.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAIN = resolve(ROOT, 'apps/api/src/main.ts');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const SCHEMA = 'dolmir_jobs';

interface RunningProcess {
  readonly child: ChildProcess;
  readonly port: number;
  lines(): Record<string, unknown>[];
  stderr(): string;
  waitForLine(message: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  exit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

let db: TestDatabase;
let api: RunningProcess;

beforeAll(async () => {
  db = await createTestDatabase();
  // The deploy step this repository was missing: without it the queues do not
  // exist and the process below cannot start at all.
  await installJobQueue({
    ownerConnectionString: db.ownerUrl,
    schema: SCHEMA,
    runtimeRole: 'dolmir_app',
    jobs: PLATFORM_JOBS,
    logger: noopLogger,
  });
  api = await start(await freePort());
  await api.waitForLine('listening', 60_000);
}, 120_000);

afterAll(async () => {
  api.child.kill('SIGKILL');
  await db.drop();
});

describe('a production process', () => {
  it('starts the background runtime before it starts listening', () => {
    const lines = api.lines();
    const started = lines.findIndex((line) => line['message'] === 'background runtime started');
    const listening = lines.findIndex((line) => line['message'] === 'listening');
    expect(started).toBeGreaterThanOrEqual(0);
    expect(listening).toBeGreaterThan(started);
  });

  it('works every job this deployment ships, on the durable queue', () => {
    const started = api.lines().find((line) => line['message'] === 'background runtime started') as
      { driver: string; jobs: string[]; scheduled: Record<string, string> } | undefined;
    expect(started?.driver).toBe('pg-boss');
    expect(started?.jobs).toEqual(PLATFORM_JOBS.map((job) => job.name));
    expect(started?.jobs).toContain('cases.execute_recommendation');
    expect(started?.jobs).toContain('cases.recover_executions');
    expect(started?.scheduled).toEqual({ 'cases.recover_executions': '*/5 * * * *' });
  });

  it('does not schedule a mailbox poll, so no company mailbox is read unattended', async () => {
    const schedules = await db.ownerPool.query<{ name: string }>(
      `SELECT name FROM ${SCHEMA}.schedule ORDER BY name`,
    );
    expect(schedules.rows.map((row) => row.name)).toEqual(['cases.recover_executions']);
  });

  it('reports over HTTP that it is ready and working the durable queue', async () => {
    const response = await fetch(`http://127.0.0.1:${String(api.port)}/health/ready`);
    const report = (await response.json()) as {
      status: string;
      checks: { jobs: { status: string; driver: string } };
    };
    expect(response.status).toBe(200);
    expect(report.status).toBe('ready');
    expect(report.checks.jobs).toEqual({ status: 'running', driver: 'pg-boss' });
  });

  it('never writes a secret to its logs', () => {
    const output = JSON.stringify(api.lines()) + api.stderr();
    expect(output).not.toContain(SECRETS_KEY);
    expect(output).not.toContain('dolmir_app_test');
    expect(output).not.toContain(db.appUrl);
  });

  it('stops the listener and the workers on SIGTERM, and exits cleanly', async () => {
    api.child.kill('SIGTERM');

    await api.waitForLine('shutdown complete', 30_000);
    const result = await api.exit();
    expect(result.code).toBe(0);

    const messages = api.lines().map((line) => line['message']);
    expect(messages).toContain('shutting down');
    expect(messages).toContain('background runtime stopped');
    // The listener closes before the workers, and the workers before the pool
    // they use.
    expect(messages.indexOf('shutting down')).toBeLessThan(
      messages.indexOf('background runtime stopped'),
    );

    // Nothing was left holding a connection to the database.
    const connections = await db.ownerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1 AND application_name LIKE $2',
      [db.name, 'dolmir-%'],
    );
    expect(connections.rows[0]?.count).toBe('0');
  }, 60_000);
});

const SECRETS_KEY = Buffer.alloc(32, 23).toString('base64');

async function start(port: number): Promise<RunningProcess> {
  // Only the variables this deployment is configured with: anything left over
  // from the test runner's own environment would be read as configuration.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('DOLMIR_')) env[key] = value;
  }
  Object.assign(env, {
    DOLMIR_ENV: 'production',
    DOLMIR_DATABASE_URL: db.appUrl,
    DOLMIR_HTTP_HOST: '127.0.0.1',
    DOLMIR_HTTP_PORT: String(port),
    DOLMIR_AUTH_ISSUER: 'https://auth.invalid/',
    DOLMIR_AUTH_AUDIENCE: 'dolmir',
    // JWKS rather than a shared secret, as production requires; nothing in this
    // test authenticates, so the endpoint is never reached.
    DOLMIR_AUTH_JWKS_URL: 'https://auth.invalid/.well-known/jwks.json',
    DOLMIR_SECRETS_KEY: SECRETS_KEY,
    DOLMIR_JOBS_DRIVER: 'pg-boss',
    DOLMIR_JOBS_SCHEMA: SCHEMA,
    DOLMIR_MAILBOX_DRIVER: 'imap_smtp',
    DOLMIR_AI_PROVIDER: 'none',
  });

  const child = spawn(TSX, ['--conditions=development', MAIN], {
    // A directory with no `.env`, so nothing local leaks into the run.
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const lines = (): Record<string, unknown>[] =>
    stdout
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });

  return {
    child,
    port,
    lines,
    stderr: () => stderr,
    exit: () => exited,
    async waitForLine(message, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = lines().find((line) => line['message'] === message);
        if (found !== undefined) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for "${message}".\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}

/** A port the operating system has just confirmed is free. */
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not take a port'));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolvePort(port);
      });
    });
  });
}
