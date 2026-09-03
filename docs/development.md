# Development

## Prerequisites

- Node 22 (`.node-version`), pnpm 10 (`corepack enable` or `npm i -g pnpm@10`)
- PostgreSQL 16: `docker compose up -d db` (creates the `dolmir` database and the roles `dolmir_owner` / `dolmir_app` from `supabase/bootstrap/00-roles.sql`), or any local cluster where you create those two roles yourself.

## First run

```bash
pnpm install
cp .env.example .env            # local values; never commit .env
pnpm db:migrate                 # applies supabase/migrations with the owner connection
pnpm doctor                     # configuration, database role, migrations, AI provider
pnpm --filter @dolmir/api cli provision-org --slug officina-demo --name "Officina Demo" --owner-subject "auth|dev" --owner-email dev@example.test
TOKEN=$(pnpm -s --filter @dolmir/api cli dev-token --subject "auth|dev" --email dev@example.test)
pnpm dev                        # http://127.0.0.1:3000
curl -s http://127.0.0.1:3000/health/ready | jq
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:3000/v1/me | jq
```

`dev-token` works only with `DOLMIR_AUTH_HS256_SECRET` set and `DOLMIR_ENV` not `production`.

## Everyday commands

| Command                      | What it does                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm check`                 | typecheck (build + tests), ESLint (type-aware), Prettier check, dependency-cruiser |
| `pnpm test:unit`             | unit tests (colocated `*.test.ts`), no database                                    |
| `pnpm test:integration`      | integration, contract, architecture and e2e projects against PostgreSQL            |
| `pnpm test:evals`            | golden-dataset evaluations (datasets not yet present)                              |
| `pnpm format`                | Prettier write                                                                     |
| `pnpm depcruise`             | architecture rules only                                                            |
| `pnpm db:migrate` / `doctor` | operator CLI shortcuts                                                             |

Integration tests need `DOLMIR_TEST_DATABASE_ADMIN_URL` (a superuser connection; default `postgres://postgres:postgres@127.0.0.1:5432/postgres`). Each run creates a fresh database, migrates it and drops it.

## Conventions that CI enforces

- **Boundaries** (`.dependency-cruiser.cjs`): see `docs/architecture/overview.md`. New module → add it to the graph rules on purpose.
- **Configuration**: only `packages/core/src/infrastructure/config/**` and `apps/api/src/composition/env.ts` may touch `process.env`. Add a variable to `EnvSchema`, the loader, `Config`, `.env.example`, and the docs — an unknown `DOLMIR_*` variable is a boot failure.
- **Vendor SDKs** live in one adapter each (`@anthropic-ai/sdk` → `ai/adapters/anthropic`, `pg` → postgres adapters, `jose` → identity adapters, `pino` → logging, `fastify` → `apps/api`).
- **Errors**: expected failures are `Result` values; infrastructure failures are `DomainError`s translated at adapter boundaries. Never throw vendor exceptions across a port.
- **Time**: through `Clock`. **Ids**: branded, from `kernel/ids.ts`. **Schemas**: Zod, the single source of truth for validation and JSON Schema.
- **Logs**: through `Logger`; fields are redacted (secrets, emails, phones, VAT numbers, IBANs). Domain records (audit, ledger, usage) are tables, not logs.
- **Migrations**: `supabase/migrations/<14-digit version>_<snake_case>.sql`, forward-only; never edit an applied migration (the checksum check refuses to continue). Every tenant table: RLS enabled and forced, a policy, grants to `dolmir_app`; append-only tables: the `forbid_mutation` trigger and no `UPDATE`/`DELETE` grant. Add the table to the SQL invariants test only if it is legitimately not tenant-scoped.
- **Tests** next to the code for units; `tests/integration`, `tests/contract`, `tests/architecture`, `tests/e2e`, `tests/evals` for the rest. A new adapter must pass its port's contract suite.
- **Commits**: small and coherent, one milestone each, every gate green.

## Adding a tool for the AI layer

1. `defineTool({ name, description, effect, permission, input, output, handler })` — the handler is deterministic code that takes validated input and the tenant context; it never receives credentials or a connection.
2. Register it in the composition root (`container.ai.tools`).
3. Unit-test it through `ToolExecutor` so permission, policy and audit are exercised, not just the handler.
