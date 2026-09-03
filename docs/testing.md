# Testing

Five Vitest projects, each a CI gate (`vitest.config.ts`):

| Project        | Location                                                 | Needs                     | Proves                                                                                                                                  |
| -------------- | -------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `unit`         | `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts` | nothing                   | kernel, use cases with in-memory adapters, fake LLM, tool executor, adapters with injected `fetch`                                      |
| `integration`  | `tests/integration`                                      | PostgreSQL 16             | RLS isolation, append-only enforcement, ledger concurrency and idempotency, migrator, AI usage rows                                     |
| `contract`     | `tests/contract`                                         | PostgreSQL (harness only) | one suite per port against **every** adapter: object storage (memory, local fs); LLM provider (fake, Anthropic over replayed exchanges) |
| `architecture` | `tests/architecture`                                     | PostgreSQL 16             | SQL invariants: forced RLS on every table, no `DELETE` grants, append-only triggers, runtime role cannot bypass RLS                     |
| `e2e`          | `tests/e2e`                                              | PostgreSQL 16             | the real HTTP application with injected requests: health, auth contract, tenant routes, permissions, correlation                        |
| `evals`        | `tests/evals`                                            | datasets + key            | golden datasets labelled from real, permitted documents (none yet); never a substitute for unit tests                                   |

Plus `pnpm depcruise` (module graph) and type-aware ESLint. Current counts: 110 unit tests, 63 integration/contract/architecture/e2e tests.

## Running

```bash
pnpm test:unit
export DOLMIR_TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
pnpm test:integration          # integration + contract + architecture + e2e
```

The harness (`tests/support/postgres-harness.ts`) creates a fresh database per file, creates the two roles if missing, runs the migrator, and drops the database afterwards. Variables prefixed `DOLMIR_TEST_` are ignored by the configuration loader.

## Recorded exchanges for the Anthropic adapter

`tests/contract/__fixtures__/anthropic/*.json` are cassettes replayed through the adapter's injected `fetch`. Each cassette states its `origin`: today all are **synthesised** from the SDK's response schema because no API key was available; they prove the adapter's mapping, not the wire format. With `DOLMIR_TEST_ANTHROPIC_API_KEY` set, the `text` and `structured` scenarios are re-recorded from the live API (`origin: recorded`). Error scenarios (429, 401, 529, refusal, truncation) stay synthesised — they cannot be induced on demand.

## What a change must come with

- A new port → a contract suite; a new adapter → passes it unchanged.
- A new table → migration with RLS/grants, and either RLS coverage by the invariants test or an explicit allow-list entry with a reason.
- A new tool → tests through `ToolExecutor` (permission, policy, audit), not only the handler.
- A new route → an e2e test for the success path and the denial path.
- A new configuration variable → a `load-config` test for the failure message.
