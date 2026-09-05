import { loadConfig } from '@dolmir/core';

import { type Runtime, startRuntime } from './composition/bootstrap.js';
import { readEnvironment } from './composition/env.js';

/**
 * Process entry point. Everything it does is process-shaped — read the
 * environment, validate configuration (fail fast, with every problem listed),
 * translate signals into a shutdown, set an exit code. What a running DOLMIR
 * consists of is decided in `composition/bootstrap.ts`, which the end-to-end
 * tests start directly.
 */
async function main(): Promise<void> {
  const config = loadConfig(readEnvironment());
  if (!config.ok) {
    process.stderr.write(`${config.error.message}\n`);
    process.exitCode = 1;
    return;
  }

  // The handlers go on before the boot, not after it: an orchestrator that
  // sends SIGTERM during a slow startup deserves a clean stop rather than a
  // half-started process killed by the default handler. Nothing is lost either
  // way — an entitlement is durable before any worker sees it — but this way
  // the pool and the queue are closed properly.
  const state: { runtime?: Runtime; requested?: string } = {};
  const onSignal = (signal: string): void => {
    if (state.runtime === undefined) {
      state.requested ??= signal;
      return;
    }
    state.runtime.shutdown(signal).catch((error: unknown) => {
      process.stderr.write(
        `shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  };
  process.on('SIGTERM', () => {
    onSignal('SIGTERM');
  });
  process.on('SIGINT', () => {
    onSignal('SIGINT');
  });

  const runtime = await startRuntime(config.value);
  state.runtime = runtime;
  if (state.requested !== undefined) await runtime.shutdown(state.requested);
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
