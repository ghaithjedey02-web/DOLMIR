import { loadConfig } from '@dolmir/core';

import { createContainer } from './composition/container.js';
import { readEnvironment } from './composition/env.js';
import { buildApp } from './http/app.js';

/**
 * Process entry point: read the environment, validate configuration (fail
 * fast, with every problem listed), wire the container, serve, and shut down
 * cleanly on SIGTERM/SIGINT.
 */
async function main(): Promise<void> {
  const config = loadConfig(readEnvironment());
  if (!config.ok) {
    process.stderr.write(`${config.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const container = createContainer(config.value);
  const app = await buildApp(container);
  const { logger } = container;

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    logger.info('shutting down', { signal });
    app
      .close()
      .then(() => container.close())
      .then(() => {
        logger.info('shutdown complete');
      })
      .catch((error: unknown) => {
        logger.error('shutdown failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exitCode = 1;
      });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  await app.listen({ host: config.value.http.host, port: config.value.http.port });
  logger.info('listening', {
    host: config.value.http.host,
    port: config.value.http.port,
    aiProvider: config.value.ai.provider,
    storage: config.value.storage.driver,
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
