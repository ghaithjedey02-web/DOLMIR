# Deployment

**Status:** no environment is deployed yet. This document describes what the code requires and the decisions already taken; hosting choices (OD-2, EU region) are made at Phase 3.

## Runtime requirements

- Node 22 LTS; one process: `node apps/api/dist/main.js` after `pnpm build`.
- PostgreSQL 16 with two roles created **once, outside migrations** (see `supabase/bootstrap/00-roles.sql` for the local version): `dolmir_owner` (owns objects, runs migrations) and `dolmir_app` (runtime; `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`). Never run the API as the owner or as a superuser: readiness reports `misconfigured` when the runtime role could bypass RLS.
- Object storage: `memory` (tests), `local` (single node). An S3-compatible adapter behind `ObjectStoragePort` is a Phase 3 addition.
- Outbound HTTPS to the AI provider when `DOLMIR_AI_PROVIDER=anthropic`.

## Configuration

All variables are listed in `.env.example` and validated at boot. Required: `DOLMIR_DATABASE_URL` (runtime role), `DOLMIR_AUTH_ISSUER`, `DOLMIR_AUTH_AUDIENCE`, and exactly one of `DOLMIR_AUTH_JWKS_URL` or `DOLMIR_AUTH_HS256_SECRET`. `DOLMIR_DATABASE_OWNER_URL` is needed only where migrations run. In production set `DOLMIR_ENV=production` (JSON logs, no dev token issuer) and use JWKS.

Secrets come from the platform's secret store into environment variables; they are never committed (`.env*` is git-ignored except `.env.example`; gitleaks runs in CI) and never logged (`Secret` wrapper, pino redaction).

## Release steps

1. `pnpm install --frozen-lockfile && pnpm build`
2. Run migrations with the owner connection: `DOLMIR_DATABASE_OWNER_URL=... node apps/api/dist/cli/main.js migrate` (idempotent, advisory-locked; safe to run on every deploy before starting the new version).
3. Start the API; wait for `GET /health/ready` → 200 (`status: ready`). `503` with the report explains what is missing (database, role, pending migrations).
4. `node apps/api/dist/cli/main.js doctor` prints the same report for humans.

## Supabase compatibility (intended production database)

The layout (`supabase/migrations`), the GUC-based policies and the two-role model work on Supabase Postgres. Create the two roles through the SQL editor with real passwords, point `DOLMIR_DATABASE_URL` at the pooled connection for `dolmir_app`, and use Supabase Auth's JWKS URL as `DOLMIR_AUTH_JWKS_URL`. PostgREST direct table access is **not** part of the design: the API mediates every access, which is what makes the LLM boundary and the human gate enforceable. Not verified against a live project yet (OD-2).

## Observability

Structured JSON logs to stdout with request, correlation, tenant and actor ids; metrics as debug log lines (`LoggingTelemetry`) until an OpenTelemetry/Sentry adapter is added behind the same ports. Health endpoints as above.

## Backups, retention, data residency

Decisions for Phase 3: managed backups of the PostgreSQL instance, retention policy per table class (audit and ledger are append-only and long-lived; usage rows aggregate), EU hosting for data and AI provider region where available. DOLMIR is a GDPR processor; AI providers are named sub-processors.
