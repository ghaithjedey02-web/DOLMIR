# ADR-0005 — Tenant isolation enforced by forced PostgreSQL Row-Level Security

**Status:** Accepted 2026-09-03 (implemented: forced RLS on every tenant table, transaction-local scopes, isolation and SQL-invariant tests) · **Date:** 2026-09-02

## Context

Directive §3 (law 3) and §18: multi-tenancy is first-class and must be enforced in the database, not only by application filters. Client data in DOLMIR includes customers' technical documents and commercial terms (see `prova_1/docs/strategy/08-risks-and-compliance.md`); a cross-tenant leak is existential.

## Decision

1. Every tenant-scoped table has a non-null `organization_id` and `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`, with a policy `USING (organization_id = dolmir.current_tenant()) WITH CHECK (organization_id = dolmir.current_tenant())`.
2. `dolmir.current_tenant()` reads the transaction-local setting `dolmir.tenant_id`; when unset it returns `NULL`, so a transaction without a tenant sees no rows and can insert none.
3. Two roles: `dolmir_owner` owns objects and runs migrations; **`dolmir_app`** is the runtime role with `NOBYPASSRLS`, `NOSUPERUSER`, no ownership, and only the DML grants each table needs.
4. The application sets the tenant once per transaction via `set_config('dolmir.tenant_id', $1, true)` inside `withTenant(orgId, fn)`; the tenant id is derived from the authenticated principal's membership for the organisation in the request path, never from the request body. System-scope operations are explicit, rare and audited.
5. Application-level filters remain as defence in depth.
6. CI proves the invariants: cross-tenant reads and writes fail; no-tenant transactions see nothing; an SQL architecture test asserts every table with `organization_id` has forced RLS and a policy.

## Why

RLS turns "we filter by tenant" from a promise in every query into a property of the connection. Forcing RLS means even the owner role is subject to policies, so a migration or maintenance script cannot leak data by accident. The GUC approach is compatible with Supabase Postgres and with connection pooling because the setting is transaction-local.

## Alternatives considered

- Schema-per-tenant — heavy migrations at scale, awkward cross-tenant analytics for the operator, no better isolation than forced RLS for this workload.
- Database-per-tenant — maximal isolation, prohibitive operational cost for SME-scale tenants.
- Application filters only — the directive forbids relying on them exclusively; one missed `WHERE` is a breach.
- Supabase `auth.uid()`-based policies with PostgREST direct access — would let clients bypass the API, which is where the LLM boundary, the human gate and the audit log are enforced. Not adopted; the API mediates every access.

## Consequences

- Every new tenant table must ship with its policy; the architecture test fails otherwise.
- Queries that legitimately span tenants (operator dashboards) use explicit system scope and are audited.
- Connection pooling in transaction mode is compatible; session-mode pooling would need care (setting is transaction-local by design).
