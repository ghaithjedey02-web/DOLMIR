# DOLMIR

**DOLMIR is an AI-native operational control layer for companies.** It sits above the systems an SME already uses — email, documents, ERP, orders, invoices, suppliers, customers, calendars — and continuously identifies what deserves attention, explains why with evidence, proposes the next action, and stops for human approval whenever judgment or risk requires it.

```
INPUT → CLASSIFY → EXTRACT → NORMALISE → RESOLVE ENTITIES → VERIFY
      → DETECT CONFLICTS / EXCEPTIONS → REASON → EXPLAIN
      → HUMAN DECISION → ACTION → OUTCOME → MEMORY
```

DOLMIR does not replace the ERP, and **DOLMIR does not guess**: when evidence is insufficient or contradictory it produces `NON DETERMINATO` — what is known, what is unknown, which evidence conflicts, what is missing, and which human decision is required.

## Status

**Phase 0 — Foundation.** This repository is the platform (multi-tenant backend, data foundation, AI layer, audit, event ledger). The public website (dolmir.com) and the sales demonstration live in a separate repository and are not changed here.

- Plan: [`docs/plans/FOUNDATION_IMPLEMENTATION_PLAN.md`](docs/plans/FOUNDATION_IMPLEMENTATION_PLAN.md)
- Architecture decisions: [`docs/architecture/adr/`](docs/architecture/adr/)
- Documentation index: [`docs/README.md`](docs/README.md)

## Four architectural laws

1. **Event ledger** — operational facts are immutable, append-only events with provenance; current state is a projection.
2. **LLM boundary** — models never touch the database and never invent business numbers; they interpret, classify, extract with evidence, reason, explain and draft through typed, permission-bounded tools.
3. **Tenant isolation** — PostgreSQL Row-Level Security is enabled and forced on every tenant table; the runtime role cannot bypass it.
4. **Canonical connectors** — domain code depends on ports (`LlmProviderPort`, `ObjectStoragePort`, `EmailAdapter`, `ErpAdapter`…), never on a vendor.

Architecture is enforced in CI (dependency rules, SQL invariants, contract suites), not promised in prose.

## Repository history

Branch `claude/dolmir-project-foundation-vlh863` (PR #1) holds an earlier, unrelated project that shared the name — an AI-native *Trader Operating System* in Python. It is historical context only and is not part of this product (see [ADR-0008](docs/architecture/adr/0008-historical-trader-os-branch.md)).
