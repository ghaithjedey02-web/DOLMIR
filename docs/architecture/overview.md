# Architecture overview

**Status:** describes the code on branch `claude/dolmir-foundation-architecture-784tn2` at the end of Phase 1 ("Phase 0" in the plan). Everything here is verifiable in the repository; nothing describes code that does not exist yet.

## What the platform is

DOLMIR is an AI Business System sold as a product and configured per company (Product Master Direction, ADR-0010). This repository holds **DOLMIR Core** (`packages/core`) and the first piece of the **Business Platform** (`apps/api`). AI Systems (`packages/systems/*`) and company-specific code arrive with the first end-to-end workflow; until then the layers exist as enforced boundaries, not as empty folders.

```
apps/api  ──────────────►  packages/core/src/index.ts  (the only entry apps may use)
   │                              │
   │  composition root            ├── kernel/          shared vocabulary: Result, errors, ids, Clock, epistemics,
   │  Fastify delivery            │                    NON_DETERMINATO, redaction, scopes, roles, ports
   │  CLI                         ├── modules/         tenancy ← identity ← access ; audit, ledger (leaves)
   │                              ├── ai/              LLM port + adapters, usage/cost, typed tools + policy
   │                              └── infrastructure/  config, context, logging, telemetry, postgres, storage
   └──────────────────────────► PostgreSQL 16 (forced RLS) · object storage · Anthropic (behind the port)
```

## The four laws and where each is enforced

| Law                         | Mechanism                                                                                                                                                            | Enforced by                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Event ledger (ADR-0004)     | `ledger_events` is append-only with mandatory provenance; `EventLedger.append` uses expected versions and idempotency keys; state is a `Projection` with checkpoints | `dolmir.forbid_mutation()` trigger, `tests/architecture/sql-invariants.test.ts`, `tests/integration/ledger-and-audit.test.ts` |
| LLM boundary (ADR-0006)     | Models are reached only through `LlmProviderPort`; effects only through typed tools run by `ToolExecutor` (permission, policy, validation, audit)                    | dependency-cruiser + ESLint (vendor SDK only in `ai/adapters/anthropic`), contract suite, `executor.test.ts`                  |
| Tenant isolation (ADR-0005) | Every tenant table has RLS enabled **and forced**; the runtime role cannot bypass it; repositories run inside `withTenant` / `withSystemScope`                       | `tests/integration/tenancy-rls.test.ts`, SQL invariants test, readiness check (`bypassesRls`)                                 |
| Canonical connectors        | Domain and application code depend on ports (`LlmProviderPort`, `ObjectStoragePort`, repositories); vendors live in adapters                                         | dependency-cruiser rules `*-only-in-*`, contract suites run against every adapter                                             |

## Module graph (enforced by `.dependency-cruiser.cjs`)

- `kernel` imports nothing else from core.
- `modules/<m>/domain` → kernel + own domain. `modules/<m>/application` → kernel, own domain, own ports, other modules' `index.ts`. `modules/<m>/adapters` → also infrastructure.
- `tenancy` ← `identity` ← `access`; `audit` and `ledger` depend on the kernel only, so every module can use them.
- `ai` → kernel, `access/index.ts` (permissions), `audit/index.ts`; `ai/adapters` may use infrastructure.
- `infrastructure` → kernel only.
- `apps/*` → `packages/core/src/index.ts` only. Packages never import apps; only end-to-end tests do.

A violation fails `pnpm depcruise`, which fails CI.

## Request lifecycle (`apps/api`)

1. `genReqId` honours a valid client `x-request-id` (UUID) or replaces it; `contextHook` builds the `ExecutionContext` (request id, correlation id) and continues the lifecycle inside `AsyncLocalStorage`, so every log line, audit row and usage row written downstream carries the ids.
2. `authHook` (under `/v1`) verifies the bearer token through `TokenVerifier` (JWKS or HS256) and records the principal.
3. `tenantHook` (under `/v1/orgs/:orgId`) resolves membership **inside the requested tenant's RLS scope** — the check and the isolation are the same mechanism — and adds tenant and actor to the context.
4. Handlers name the permission they need (`Authorizer.require`) and run their queries inside `withTenant`.
5. Every error becomes an RFC 9457 problem (`application/problem+json`); infrastructure and internal failures are logged and reported generically.

## What exists, in one table

| Concern          | Core                                                                                                     | Platform (`apps/api`)                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Configuration    | `loadConfig` (fail fast, unknown `DOLMIR_*` rejected, `Secret` wrapping)                                 | `composition/env.ts` reads `process.env` + `.env`             |
| Tenancy          | organisations, users, memberships; provisioning; tenant-context resolution                               | `/v1/me`, `/v1/orgs/:orgId`, CLI `provision-org`              |
| Identity, access | JWT verification, `Principal`; permissions, role matrix v2, `Authorizer`, human-only permissions         | bearer auth, permission checks                                |
| Audit, ledger    | `AuditTrail`, `EventLedger`, projections                                                                 | `/v1/orgs/:orgId/audit`; every system scope audited           |
| AI               | provider port, tiers, Anthropic + fake adapters, cache port, cost book, `ai_usage`, tools, action policy | `/v1/orgs/:orgId/ai-usage`; readiness reports provider status |
| Storage          | content-addressed `ObjectStoragePort` (memory, local fs)                                                 | selected by configuration                                     |
| Observability    | `Logger` (pino, redacted, context-bound), `Telemetry` (log-backed), diagnostics, migration status        | `/health/live`, `/health/ready`, CLI `doctor`                 |

## What deliberately does not exist yet

Document ingestion, entity resolution, company memory and rules, connectors, jobs, the agent loop, persisted approvals, the dashboard. Each is scheduled in `docs/plans/PRODUCT_DIRECTION_ALIGNMENT.md` §8 and designed to land as new modules and migrations without changing the contracts above.
