# DOLMIR

**DOLMIR is an AI Business System for companies.** It connects to the systems a company already uses — email, documents, ERP, orders, invoices, suppliers, customers — understands what is happening, reasons over it with evidence, recommends and drafts, stops for human approval where policy requires it, executes approved actions, and records what happened. It is built once as a platform and configured for each company.

```
DATA → AI UNDERSTANDING → REASONING → EVIDENCE → RECOMMENDATION
     → HUMAN APPROVAL → ACTION → RESULT → COMPANY MEMORY
```

DOLMIR is not a chatbot, not an ERP and not a dashboard of generic charts. **DOLMIR does not guess**: business numbers come from structured data and deterministic code; claims carry evidence; when evidence is insufficient or contradictory the answer is `NON DETERMINATO` — what is known, what is unknown, which evidence conflicts, what is missing, and which human decision is required.

## Product layers

| Layer                        | What it is                                                                                                                                      | Where                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **DOLMIR Core**              | The reusable engine: AI model abstraction and routing, cost tracking, typed tools with policy, event ledger, evidence, tenancy, security, audit | `packages/core`                                                                            |
| **DOLMIR Business Platform** | The product a company buys: workspace, AI Agent, documents, entities, approvals, activity, integrations, settings, AI usage                     | `apps/api` (this phase), `apps/web` (later)                                                |
| **AI Systems**               | Reusable capabilities built on Core: commercial inbox intelligence, procurement documents, material intelligence…                               | `packages/systems/<system>` (from Phase 2)                                                 |
| **Company-specific AI**      | Configuration first — rules, terminology, policies, connectors — and custom agents only where genuinely needed                                  | tenant configuration in the database; `packages/tenants/<slug>` only when code is required |

See [ADR-0010](docs/architecture/adr/0010-product-layering-core-platform-systems.md) and the [product-direction alignment](docs/plans/PRODUCT_DIRECTION_ALIGNMENT.md).

## Status

**Phase 1 — Core foundation: complete** (the plan's "Phase 0", 2026-09-03). This repository holds the platform: multi-tenant backend with forced Row-Level Security, fail-fast configuration, JWT authentication and a role matrix, append-only audit log and event ledger, object storage, the AI layer (provider port, Anthropic adapter, cost tracking, typed tools with action policy), a Fastify API with health, identity and tenant routes, and an operator CLI. Next: the first end-to-end AI System, Commercial Inbox Intelligence (see the alignment document). The public website (dolmir.com) lives in a separate repository and is not changed here.

## Getting started

```bash
docker compose up -d db          # PostgreSQL 16 with the two roles
pnpm install && cp .env.example .env
pnpm db:migrate && pnpm doctor
pnpm dev                         # API on http://127.0.0.1:3000
```

Full instructions, commands and conventions: [`docs/development.md`](docs/development.md).

- Alignment with the Product Master Direction: [`docs/plans/PRODUCT_DIRECTION_ALIGNMENT.md`](docs/plans/PRODUCT_DIRECTION_ALIGNMENT.md)
- Foundation plan: [`docs/plans/FOUNDATION_IMPLEMENTATION_PLAN.md`](docs/plans/FOUNDATION_IMPLEMENTATION_PLAN.md)
- Architecture decisions: [`docs/architecture/adr/`](docs/architecture/adr/)
- Documentation index: [`docs/README.md`](docs/README.md)

## Architectural laws

1. **Event ledger** — operational facts are immutable, append-only events with provenance; current state is a projection.
2. **LLM boundary** — models never touch the database and never invent business numbers; they interpret, classify, extract with evidence, reason, explain and draft through typed tools. Every tool declares an effect (`read`, `analyze`, `draft`, `act`) and runs under the company's action policy (`READ_ONLY` … `REQUIRE_APPROVAL` … `AUTO_EXECUTE`); approval is a human act.
3. **Tenant isolation** — PostgreSQL Row-Level Security is enabled and forced on every tenant table; the runtime role cannot bypass it.
4. **Canonical connectors** — domain code depends on ports (`LlmProviderPort`, `ObjectStoragePort`, connectors…), never on a vendor.

Architecture is enforced in CI (dependency rules, SQL invariants, contract suites), not promised in prose.

## Repository history

Branch `claude/dolmir-project-foundation-vlh863` (PR #1) holds an earlier, unrelated project that shared the name — an AI-native _Trader Operating System_ in Python. It is historical context only and is not part of this product (see [ADR-0008](docs/architecture/adr/0008-historical-trader-os-branch.md)).
