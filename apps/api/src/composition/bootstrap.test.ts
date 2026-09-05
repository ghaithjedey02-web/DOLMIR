import { createServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { type Config, type Logger, loadConfig } from '@dolmir/core';

import { type Runtime, startRuntime } from './bootstrap.js';
import { PLATFORM_JOBS } from './jobs.js';

/**
 * Booting, and failing to boot.
 *
 * The invariant under test is the one the P0 was about: a DOLMIR process
 * serves HTTP only if it is also working the background queue. Both halves
 * matter — that a healthy boot starts the workers first, and that a boot which
 * cannot start them does not fall back to serving anyway.
 *
 * No database is involved. The failing case points pg-boss at a closed port,
 * which is what an unreachable PostgreSQL looks like from here.
 */
const base = {
  DOLMIR_AUTH_ISSUER: 'http://localhost/dev-auth',
  DOLMIR_AUTH_AUDIENCE: 'dolmir',
  DOLMIR_AUTH_HS256_SECRET: 'test-only-secret-value-at-least-32-chars',
  DOLMIR_DATABASE_URL: 'postgres://dolmir_app:pw@127.0.0.1:1/dolmir',
};

function configure(overrides: Record<string, string>): Config {
  const result = loadConfig({ ...base, ...overrides });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** A logger that records, so the boot sequence can be read back in order. */
function recorder(): { logger: Logger; messages: () => string[] } {
  const messages: string[] = [];
  const record =
    (level: string) =>
    (message: string): void => {
      messages.push(`${level}:${message}`);
    };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  return { logger, messages: () => [...messages] };
}

let running: Runtime | undefined;
afterEach(async () => {
  await running?.shutdown('test');
  running = undefined;
});

describe('a healthy boot', () => {
  it('starts the workers before it listens, and answers once it does', async () => {
    const port = await freePort();
    const { logger, messages } = recorder();

    running = await startRuntime(configure({ DOLMIR_HTTP_PORT: String(port) }), { logger });

    const order = messages();
    expect(order.indexOf('info:background runtime started')).toBeLessThan(
      order.indexOf('info:listening'),
    );
    expect(running.container.jobs.registered()).toEqual(PLATFORM_JOBS.map((job) => job.name));

    const response = await fetch(`http://127.0.0.1:${String(port)}/health/live`);
    expect(response.status).toBe(200);
  });

  it('shuts down once, however many times it is asked', async () => {
    const port = await freePort();
    const { logger, messages } = recorder();
    const runtime = await startRuntime(configure({ DOLMIR_HTTP_PORT: String(port) }), { logger });

    await Promise.all([runtime.shutdown('SIGTERM'), runtime.shutdown('SIGINT')]);
    await runtime.shutdown('again');

    expect(messages().filter((line) => line === 'info:shutdown complete')).toHaveLength(1);
    expect(runtime.container.jobs.registered()).toEqual([]);
    expect(runtime.container.pool.ended).toBe(true);
    // The port is free again, so the listener really closed.
    await expect(freePortIs(port)).resolves.toBe(true);
  });
});

describe('a boot that cannot start the workers', () => {
  it('never listens, and leaves nothing open', async () => {
    const port = await freePort();
    const { logger, messages } = recorder();

    // Production means pg-boss, and the database is a closed port.
    await expect(
      startRuntime(
        configure({
          DOLMIR_ENV: 'production',
          DOLMIR_SECRETS_KEY: Buffer.alloc(32, 5).toString('base64'),
          DOLMIR_JOBS_DRIVER: 'pg-boss',
          DOLMIR_STORAGE_DRIVER: 'local',
          DOLMIR_STORAGE_LOCAL_ROOT: '/var/lib/dolmir/objects',
          DOLMIR_AI_PROVIDER: 'anthropic',
          DOLMIR_AI_ANTHROPIC_API_KEY: 'sk-ant-test-placeholder-never-sent',
          DOLMIR_HTTP_PORT: String(port),
        }),
        { logger },
      ),
    ).rejects.toThrow();

    const order = messages();
    expect(order).toContain('error:startup failed');
    // The whole point: no listener, no half-running deployment that would take
    // approvals it cannot carry out.
    expect(order).not.toContain('info:listening');
    await expect(freePortIs(port)).resolves.toBe(true);
  }, 30_000);
});

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

async function freePortIs(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const server = createServer();
    server.on('error', () => {
      resolveFree(false);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolveFree(true);
      });
    });
  });
}
