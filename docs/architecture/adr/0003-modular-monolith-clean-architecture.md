# ADR-0003 — Modular monolith with Clean Architecture boundaries enforced in CI

**Status:** Accepted 2026-09-03 (implemented; boundaries enforced by dependency-cruiser and ESLint in CI) · **Date:** 2026-09-02

## Context

DOLMIR must support many future capabilities (Directive §6) without a redesign, but the directive forbids premature microservices and "dozens of empty folders". Boundaries that are only conventions erode over years and across AI-assisted sessions.

## Decision

1. **One deployable** (`apps/api`) and **one core package** (`packages/core`) containing modules (bounded contexts) — `tenancy`, `identity`, `access`, `audit`, `ledger` in Phase 0 — plus the `ai` layer, the `kernel` and shared `infrastructure` adapters.
2. Every module is layered `domain/` → `application/` → `adapters/`, with a public `index.ts`. Dependencies point inward: domain depends only on the kernel; application depends on domain and its own ports; adapters implement ports and may use `infrastructure/`; nothing in `packages/core` depends on `apps/`.
3. Modules depend on each other only through their public index and only along a declared acyclic graph: `tenancy ← identity ← access`; `audit` and `ledger` are leaves any module may use; `ai` may use `kernel`, `access` and `audit`.
4. Vendor SDKs appear only in adapter folders (`ai/adapters/anthropic`, future connectors). `process.env` is read only by the composition root's configuration loader.
5. **Enforcement:** dependency-cruiser rules and ESLint restrictions run in CI; a violation is a failing build, not a review comment. SQL invariants (RLS, append-only grants) are tested the same way.
6. Wiring is explicit constructor injection from one composition root per delivery adapter. No DI framework, no service locator.

## Why

Cohesion and extractability without distributed-systems cost. A module extracted into its own service later is a build/deploy change, not a rewrite, because it already has explicit ports and no hidden coupling.

## Alternatives considered

- Microservices from the start — premature; one team, one client.
- Single package with folder conventions only — indistinguishable from the enforced version on day one, indistinguishable from spaghetti in year three.
- One pnpm package per module — clean, but multiplies build configuration before any module needs independent versioning. Revisit when a second deployable exists.

## Consequences

- Adding a module means adding a folder, a rule entry in `.dependency-cruiser.cjs`, and its migrations — nothing else changes.
- Cross-module reads go through application services, not shared tables, which keeps RLS and audit uniform.
