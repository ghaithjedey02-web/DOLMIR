import { defineConfig } from 'vitest/config';

/**
 * Test layers (Directive §20, plan §L). Each layer is a Vitest project so it
 * can be run and gated independently:
 *
 *   unit          pure code next to its source; in-memory adapters, fake LLM
 *   integration   real PostgreSQL (RLS, append-only, ledger, HTTP app)
 *   contract      one suite per port, executed against every adapter
 *   architecture  dependency rules and SQL invariants (a violation fails CI)
 *   e2e           the HTTP application with injected requests against real PostgreSQL
 *   evals         golden datasets; never a substitute for unit tests
 */
export default defineConfig({
  test: {
    environment: 'node',
    reporters: process.env['CI'] ? ['default', 'github-actions'] : ['default'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.ts', '**/__fixtures__/**', '**/index.ts'],
      reportsDirectory: 'coverage',
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          // Integration tests share one database; keep files sequential so
          // schema setup and teardown never race.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'architecture',
          include: ['tests/architecture/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'evals',
          include: ['tests/evals/**/*.test.ts'],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
