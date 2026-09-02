# ADR-0008 — Relationship to the historical Trader OS branch and prior documents

**Status:** Accepted · **Date:** 2026-09-02

## Context

This repository contains branch `claude/dolmir-project-foundation-vlh863` (and open PR #1) with a Python "AI-native Trader Operating System": ICT/SMC market analysis, trading agents, a Risk Gate, a trading constitution and a 15-phase roadmap. Its README calls its foundation document "the law of the project". The Master Build Directive (§0) states that this is **not** the current DOLMIR product, and must not be merged, copied, revived, modified or deleted.

The current product is a B2B operational control layer for Italian SMEs, documented in Notion ("Dolmir — Business OS", "DOLMIR — Product Foundation", "Strategy") and in `ghaithjedey02-web/prova_1`.

## Decision

1. The Trader OS branch and PR #1 are **left untouched**: not merged, not rebased, not closed, not deleted by this work. Any action on them is the product owner's.
2. Its documents are **historical context**, not law. Where this repository's ADRs and the Master Build Directive conflict with them, the ADRs and the directive prevail.
3. Domain-agnostic **design patterns** from that branch may be re-expressed in the platform (Result type, fail-fast configuration rejecting unknown environment variables, provider port with recorded-exchange contract tests, cost instrumentation as a decorator, epistemic status types, append-only repository ports, architecture rules in CI). **Code** is not copied and the trading domain is not revived.
4. `main`'s previous `Docs/REDME.md` is renamed to `docs/README.md` so that the directive's `docs/` folder does not coexist with a case-different `Docs/` (which breaks checkouts on case-insensitive filesystems).

## Why

The directive is explicit, and the two products share a name but not a domain, a runtime or a customer. Preserving the branch keeps history and respects the owner's prerogative; re-using proven patterns avoids re-deriving them.

## Alternatives considered

- Deleting or archiving the branch — forbidden by the directive.
- Building the platform on top of the Python kernel — would inherit a trading-shaped runtime and violate ADR-0002.

## Consequences

- Readers arriving at the repository see one README describing the current product and pointing to the historical branch for context.
- If the owner later wants the Trader OS preserved elsewhere, moving it is a separate, explicit task.
