# ADR-0014 — Background jobs with pg-boss behind a queue port

**Status:** Accepted · **Date:** 2026-09-03

## Context

Ingestion, analysis and action execution are asynchronous and must survive restarts. Direction §16 lists pg-boss; the owner confirmed it (OD-14). The modular monolith (ADR-0003) prefers one database and no extra services.

## Decision

1. `JobQueuePort` in Core: `enqueue(name, payload, { idempotencyKey, tenantId, delay })`, `schedule(name, cron, payload)`, `work(name, handler)`. Payloads are small references (ids), never documents.
2. pg-boss is the production adapter, in the same PostgreSQL database in its own schema. Its schema is created and migrated with the **owner** connection at deploy time (a CLI command), and the runtime role receives the grants it needs; the API process never runs schema changes.
3. Every handler re-enters the tenant scope named in the payload before touching tenant data; scheduling across tenants (the poll scheduler) runs in system scope and is audited. Handlers are idempotent and record their outcome; retries are bounded and visible.
4. An in-memory adapter runs the same handlers synchronously for unit and end-to-end tests.

## Why

One database keeps transactions, backups and tenancy simple; pg-boss gives retries, scheduling and singleton keys without another service. The port keeps a future move (a hosted queue, or worker processes) local to one adapter.

## Alternatives considered

- Hand-written jobs table with `SKIP LOCKED` — less code today, more to maintain (retries, scheduling, archiving).
- Redis-based queue — a second service to operate and secure for a Phase 2 product.
- n8n as the scheduler — orchestration outside DOLMIR's audit and tenancy for core pipeline steps (ADR-0009).

## Consequences

- Deployments run `dolmir jobs:migrate` (owner connection) before starting the API.
- Job names are part of the platform vocabulary; systems enqueue only through Core use cases.
