import type { FastifyInstance } from 'fastify';

import type { Config } from '@dolmir/core';

import { buildApp, type AppOptions } from '../http/app.js';
import { type Container, type ContainerOptions, createContainer } from './container.js';

/**
 * Starting and stopping DOLMIR, in one place that a test can call.
 *
 * The invariant this file exists to hold: **a DOLMIR process that is serving
 * HTTP is also working the background queue.** Approving a recommendation
 * commits an entitlement and hands the work to a queue; if nobody is working
 * that queue, the company has authorised something that will never happen and
 * the API will cheerfully keep taking approvals. So the background runtime
 * starts *before* the listener, and a failure to start it stops the boot —
 * there is no degraded mode where the API answers and the workers do not.
 *
 * `main.ts` is the process around this: signals, exit codes, stderr. Everything
 * that decides what a running DOLMIR *is* lives here, so the end-to-end test
 * can start the real thing rather than an approximation of it.
 */
export interface StartRuntimeOptions extends ContainerOptions {
  readonly app?: AppOptions;
}

export interface Runtime {
  readonly container: Container;
  readonly app: FastifyInstance;
  /** Where the server is actually listening, port 0 resolved. */
  readonly address: string;
  /** Idempotent: concurrent and repeated calls await the same shutdown. */
  shutdown(reason: string): Promise<void>;
}

export async function startRuntime(
  config: Config,
  options: StartRuntimeOptions = {},
): Promise<Runtime> {
  const { app: appOptions, ...containerOptions } = options;
  const container = createContainer(config, containerOptions);
  const { logger } = container;

  logger.info('starting', {
    env: config.env,
    jobs: config.jobs.driver,
    jobsSchema: config.jobs.schema,
    storage: config.storage.driver,
    aiProvider: config.ai.provider,
    mailbox: config.mailbox.driver,
  });

  let app: FastifyInstance | undefined;
  try {
    // Workers first. Not a preference — the invariant above.
    await container.jobs.start();
    app = await buildApp(container, appOptions ?? {});
    await app.listen({ host: config.http.host, port: config.http.port });
  } catch (error) {
    // A boot that failed leaves nothing open: no pg-boss connection, no pool,
    // no listener. The process exits non-zero and the orchestrator retries.
    await closeQuietly(app, container, error);
    throw error;
  }

  const address = describeAddress(app, config);
  logger.info('listening', {
    address,
    env: config.env,
    jobs: container.jobs.registered(),
    aiProvider: config.ai.provider,
    storage: config.storage.driver,
  });

  let shuttingDown: Promise<void> | undefined;
  const shutdown = (reason: string): Promise<void> => {
    shuttingDown ??= (async () => {
      logger.info('shutting down', { reason });
      // HTTP first, so nothing new is accepted and in-flight requests finish;
      // then the container, which stops the workers before it closes the pool
      // the workers use. Shutdown itself performs no business action: a
      // recommendation approved by the last in-flight request is already a
      // durable entitlement, and recovery re-enqueues it after the restart.
      //
      // `finally`, because a listener that refuses to close must not be the
      // reason a queue connection and a database pool stay open.
      try {
        await app.close();
      } finally {
        await container.close();
      }
      logger.info('shutdown complete', { reason });
    })();
    return shuttingDown;
  };

  return { container, app, address, shutdown };
}

async function closeQuietly(
  app: FastifyInstance | undefined,
  container: Container,
  cause: unknown,
): Promise<void> {
  const { logger } = container;
  logger.error('startup failed', {
    error: cause instanceof Error ? cause.message : String(cause),
  });
  if (app !== undefined) {
    try {
      await app.close();
    } catch (error) {
      logger.warn('the http server could not be closed after a failed start', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  try {
    await container.close();
  } catch (error) {
    logger.warn('resources could not be released after a failed start', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function describeAddress(app: FastifyInstance, config: Config): string {
  const address: unknown = app.server.address();
  if (typeof address === 'string') return address;
  if (address !== null && typeof address === 'object' && 'port' in address) {
    return `${config.http.host}:${String((address as { port: number }).port)}`;
  }
  return `${config.http.host}:${String(config.http.port)}`;
}
