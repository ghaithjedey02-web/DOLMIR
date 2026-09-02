# ADR-0010 — Product layering: Core, Business Platform, AI Systems, Company-specific AI

**Status:** Accepted · **Date:** 2026-09-02

## Context

The Product Master Direction (2026-09-02) defines DOLMIR as an AI Business System sold as a product and customised per company: **one Core → many AI Systems → many companies → company-specific configuration** (Direction §7, §10). It requires reuse of the existing technical foundation and forbids rewriting it (§16, §24). Phase 0 has built a modular monolith in `packages/core` with enforced module boundaries (ADR-0003).

## Decision

1. **Core** is `packages/core`: kernel, infrastructure adapters, modules (tenancy, identity, access, audit, ledger), the AI layer (provider port, routing, cost tracking, typed tools, policy) and, as they arrive, document ingestion, entity resolution, company memory, connectors, jobs. Core contains no industry-specific logic.
2. **Business Platform** is what customers buy: `apps/api` (HTTP delivery, composition root, CLI) and later `apps/web` (dashboard and agent surface). Platform-level application services (workspace configuration, attention items, agent conversation, activity) live in `packages/core/src/platform/` under the same layer rules as modules.
3. **AI Systems** are reusable capabilities (commercial inbox intelligence, procurement documents, material intelligence…). Each is a workspace package `packages/systems/<system>/` depending on the public API of `@dolmir/core` only. It contributes tools, workflows, schemas, prompts and evals; it never reaches into Core internals or another system's internals.
4. **Company-specific AI** is configuration first: rules, terminology, permission policies, connectors and workflow settings stored per tenant in the database. Code is added only when a company genuinely needs custom agents or tools, as `packages/tenants/<slug>/` depending on Core and Systems.
5. Dependency-cruiser enforces the graph: `systems → core/index.ts`; `tenants → core/index.ts + systems/*/index.ts`; `apps → core, systems, tenants`; nothing imports `apps`. The rules are added when the first package of each kind is created — empty directories are not created in advance.
6. The four layers do not imply four deployables. Phase 2 ships one API process and one web application; systems are compiled in.

## Why

The moat is the company-specific layer on a standard core (Direction §25). That is only economical if the core is genuinely reusable and the systems are genuinely separable. Enforced package boundaries make "generalise the first workflow into a module" (Phase 4) a move, not a rewrite.

## Alternatives considered

- One package with feature folders — cheapest today; boundaries erode as systems multiply.
- A service per AI System — operational cost and network boundaries the team does not need; violates the modular-monolith decision (ADR-0003).
- Tenant customisation only through code — makes every customer a fork; contradicts "standard core + configuration + custom AI".

## Consequences

- `packages/core/src/platform/` and `packages/systems/` are introduced by Phase 2 work; the ADR fixes the shape, not the date.
- Material availability intelligence, previously a candidate for the whole product, is one future system package (Direction §9).
- The public website remains in the sibling repository `prova_1`; the dashboard belongs to this repository's Platform layer (open decision OD-12).
