# ADR-0012 — AI Systems implement one contract over a Core case engine

**Status:** Accepted · **Date:** 2026-09-03

## Context

The Product Master Direction (§7, §10, §20) requires one Core, many AI Systems, many companies, and a first system that proves the whole chain INGEST → UNDERSTAND → RESOLVE → REASON → EVIDENCE → RECOMMEND → HUMAN APPROVAL → ACTION → OUTCOME. The owner confirmed Commercial Inbox Intelligence as the first system (OD-10) and forbade architecting DOLMIR as an e-mail product.

## Decision

1. The chain is implemented once in Core: `documents` (ingest), `entities` (resolve), `workspace` (company configuration), `cases` (findings, recommendations, approvals, actions, outcomes), `connectors` and `jobs`. No stage lives in a system package.
2. An AI System is a workspace package `packages/systems/<key>` exporting one `AiSystemDefinition`: key, name, version, the document kinds it analyses, the tools it contributes, and `analyze(input, context) → CaseDraft | null`. It depends on `@dolmir/core` only. Dependency-cruiser enforces: systems never import apps or other systems' internals; apps compose systems.
3. A `CaseDraft` is declarative: findings are `Claim`s with evidence, recommendations are tool name + input + rationale. Core validates recommendation inputs against the tool's schema before storing them, resolves the policy level, opens the case and drives approval and execution. A system cannot execute anything itself.
4. Case state is a synchronous projection of ledger events (`case/<id>` streams) and can be rebuilt from the ledger. The ledger events are the immutable record of every decision and execution; the `approvals` and `actions` tables derived from them are insert-only for the runtime role, and only the owner role, during a rebuild, may clear them.
5. Every case records the system key and version that produced it, so behaviour changes are traceable and evaluable.

## Why

Reuse is only real if the second system needs no Core change. Declarative case drafts keep systems honest (they propose, Core decides and records) and keep the human gate, permissions and audit structural rather than per-system.

## Alternatives considered

- Systems as folders inside Core — boundaries erode; the first system would become the shape of everything.
- Systems executing their own actions — bypasses the policy and approval path.
- Free-form agent plans instead of cases — unauditable, not comparable across systems.

## Consequences

- Adding a system = one package with tests and evals, one registration line in the composition root.
- Material intelligence, procurement documents and the others are systems over the same engine; their extra tables are their own migrations, still RLS-forced.
