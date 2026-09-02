# ADR-0001 — Record architecture decisions

**Status:** Accepted · **Date:** 2026-09-02

## Context

DOLMIR is intended to be a long-lived, multi-tenant platform built by a small team with AI assistance across many sessions that have no memory of each other. Decisions that live only in chat transcripts are lost; decisions that live only in code are unexplained. The Master Build Directive (§22) requires an ADR for every material architectural decision, stating context, decision, why, alternatives, consequences and status.

## Decision

Architecture decisions are recorded as numbered Markdown files under `docs/architecture/adr/`, one decision per file, using this template:

```
# ADR-NNNN — Title
**Status:** Proposed | Accepted | Superseded by ADR-MMMM | Deprecated · **Date:** YYYY-MM-DD
## Context
## Decision
## Why
## Alternatives considered
## Consequences
```

Rules:

1. A decision is *material* when reversing it later would require changing more than one module, a database schema, a security boundary, an external contract, or the runtime.
2. ADRs are never edited to change a decision; a new ADR supersedes the old one and both link to each other. Typos and clarifications may be fixed in place.
3. A contradiction between a current document and this repository's implementation is resolved by an ADR, never silently (Directive §25).
4. Status `Proposed` means the decision is implemented on a branch and awaits the product owner's review; `Accepted` means reviewed and merged.

## Why

The template forces the "why" and the alternatives to be written down, which is what a future reader (human or AI session) needs to avoid relitigating or accidentally reversing a decision.

## Alternatives considered

- Decisions in a single living `ARCHITECTURE.md` — drifts, loses history, hard to reference.
- Decisions only in commit messages — not discoverable, no status lifecycle.

## Consequences

- Every pull request that changes a boundary, a schema, a port or a dependency direction includes or updates an ADR.
- The ADR index is the entry point for understanding *why* the system is shaped as it is.
