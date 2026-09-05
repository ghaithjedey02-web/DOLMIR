# Deployment

**Status:** no environment is deployed yet. This document describes what the code requires and the decisions already taken; hosting choices (OD-2, EU region) are made at Phase 3.

## Runtime requirements

- Node 22 LTS; one process: `node apps/api/dist/main.js` after `pnpm build`. That process serves HTTP **and** works the background queue — it starts the workers before it starts listening, and refuses to listen if it cannot. There is no separate worker deployment and no mode in which the API answers while approved actions sit unexecuted.
- PostgreSQL 16 with two roles created **once, outside migrations** (see `supabase/bootstrap/00-roles.sql` for the local version): `dolmir_owner` (owns objects, runs migrations) and `dolmir_app` (runtime; `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`). Never run the API as the owner or as a superuser: readiness reports `misconfigured` when the runtime role could bypass RLS.
- Object storage: `memory` (tests), `local` (single node). An S3-compatible adapter behind `ObjectStoragePort` is a Phase 3 addition.
- Outbound HTTPS to the AI provider when `DOLMIR_AI_PROVIDER=anthropic`.

## Configuration

All variables are listed in `.env.example` and validated at boot. Required: `DOLMIR_DATABASE_URL` (runtime role), `DOLMIR_AUTH_ISSUER`, `DOLMIR_AUTH_AUDIENCE`, and exactly one of `DOLMIR_AUTH_JWKS_URL` or `DOLMIR_AUTH_HS256_SECRET`. `DOLMIR_DATABASE_OWNER_URL` is needed only where migrations and the job-queue installation run. In production set `DOLMIR_ENV=production` (JSON logs, no dev token issuer) and use JWKS.

Production additionally requires, and the loader refuses to boot without:

| Variable                          | Why production insists                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `DOLMIR_SECRETS_KEY`              | 32 random bytes, base64. Encrypts per-tenant connector credentials; without it no connection can be stored (ADR-0013).            |
| `DOLMIR_JOBS_DRIVER=pg-boss`      | Work held only in one process's memory is lost on restart, and approved actions are work the company has committed to (ADR-0014). |
| `DOLMIR_MAILBOX_DRIVER=imap_smtp` | The in-memory mailbox never sends a real message.                                                                                 |

`DOLMIR_JOBS_SCHEMA` (default `dolmir_jobs`) names the schema pg-boss owns.

Secrets come from the platform's secret store into environment variables; they are never committed (`.env*` is git-ignored except `.env.example`; gitleaks runs in CI) and never logged (`Secret` wrapper, pino redaction).

## Release steps

1. `pnpm install --frozen-lockfile && pnpm build`
2. Run migrations with the owner connection: `DOLMIR_DATABASE_OWNER_URL=... node apps/api/dist/cli/main.js migrate` (idempotent, advisory-locked; safe to run on every deploy before starting the new version).
3. Install the job queue with the same owner connection: `node apps/api/dist/cli/main.js jobs:install`. This creates the pg-boss schema, one queue per job the platform ships, and the grants the runtime role needs inside that schema. It is idempotent and belongs on **every** deploy, next to the migration step — the runtime role deliberately cannot create a queue, so a deployment that skips this has nowhere to put approved work. The role granted is taken from `DOLMIR_DATABASE_URL`; `--role <name>` overrides it where the two genuinely differ.
4. Start the API; wait for `GET /health/ready` → 200 (`status: ready`). `503` with the report explains what is missing (database, role, pending migrations). `checks.jobs` reports whether this process is working the queue and with which adapter.
5. `node apps/api/dist/cli/main.js doctor` prints the same report for humans.

Stop the process with **SIGTERM** (or SIGINT). Shutdown closes the listener, then the workers — letting a job in flight finish under the queue's own graceful timeout — then the database pool, and logs `shutdown complete`. Sending it twice is harmless. A process killed with SIGKILL loses nothing durable: an approval's entitlement is committed before any worker sees it, and the recovery sweep re-enqueues what was left unfinished.

A queue's policy is fixed by pg-boss when the queue is created and cannot be changed in place. If a job's concurrency ever changes, `jobs:install` stops with `JOB_QUEUE_POLICY_MISMATCH` rather than leaving a queue that accepts duplicates it should refuse; drain that queue and drop it, then install again.

## Supabase compatibility (intended production database)

The layout (`supabase/migrations`), the GUC-based policies and the two-role model work on Supabase Postgres. Create the two roles through the SQL editor with real passwords, point `DOLMIR_DATABASE_URL` at the pooled connection for `dolmir_app`, and use Supabase Auth's JWKS URL as `DOLMIR_AUTH_JWKS_URL`. PostgREST direct table access is **not** part of the design: the API mediates every access, which is what makes the LLM boundary and the human gate enforceable. Not verified against a live project yet (OD-2).

## Observability

Structured JSON logs to stdout with request, correlation, tenant and actor ids; metrics as debug log lines (`LoggingTelemetry`) until an OpenTelemetry/Sentry adapter is added behind the same ports. Health endpoints as above.

The startup and shutdown sequence is legible in the logs and carries no secret: `starting` (environment, queue driver and schema, storage, AI provider, mailbox driver), `background runtime started` (the job names being worked and the one cron schedule), `listening` (address), then on a signal `shutting down`, `background runtime stopped`, `shutdown complete`. Connection URLs, keys and credentials never appear — they are wrapped in `Secret` and redacted by pino.

## Backups, retention, data residency

Decisions for Phase 3: managed backups of the PostgreSQL instance, retention policy per table class (audit and ledger are append-only and long-lived; usage rows aggregate), EU hosting for data and AI provider region where available. DOLMIR is a GDPR processor; AI providers are named sub-processors.
