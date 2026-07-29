# ADR 0001 — Phase 2B: the first vertical slice (`dolmir analyze`)

**Status:** Accepted · **Phase:** 2B (Roadmap) · **Date:** 2026-07-29

Phase 2B turns the domain-agnostic reasoning engine (Phase 2A) into one real,
explainable trading analysis end-to-end: `dolmir analyze <chart>` runs
perception → understanding → hypotheses → debate → falsification → confidence
→ chief decision → deterministic Risk Gate → explained, persisted decision.
This ADR records the decisions that were genuinely open, so a later reader
understands *why*, not just *what*.

## Context that shaped every decision

The build environment has **no LLM API key, no network to Anthropic, and no
vendor SDK installed**. That is not an obstacle to Phase 2B — it is exactly
the situation the roadmap's "cassette-based contract test suite" was designed
for. Everything model-facing is therefore built behind a port and verified
**offline and deterministically**; the live path is real and complete, and
the trader activates it with their own key. Prompt quality is explicitly
unvalidated until the Phase 6 evaluation harness — accepted and documented,
not hidden (Roadmap Phase 2B risks).

## Decisions

### 1. The LLM adapter is split over an injected HTTP transport

`AnthropicLLMProvider` is pure request-building and response-parsing over an
`AsyncHttpTransport` port. The production transport is `UrllibHttpTransport`
(standard library, run in a worker thread) — **no third-party HTTP dependency
enters the tree**, and none was available anyway. Contract tests replay
hand-authored **cassettes** through the real adapter, exercising payload
shape, status-to-error mapping, and response parsing with zero network. This
is the template every future provider (Phase 11) copies. No vendor SDK type
crosses the `providers/llm` boundary (EC §4).

`complete()` returns `Result[LLMResponse, LLMError]` rather than raising:
across many independently-failing model calls, a failure is data the pipeline
routes around (CA §8), not an exception that unwinds a debate.

### 2. Trading agents live in `orchestration/agents/trading/`, not in an engine

The four agents are graph nodes — they import the trace vocabulary and the
stage bases. The import contracts forbid engines from importing orchestration,
so agents *cannot* live in an engine. Orchestration, by contrast, may depend
on engines and providers (CA §4 table), which is precisely how a trading node
reaches the Risk Gate and the LLM/vision providers **without the generic
engine ever learning what a trade is**. Domain-agnosticism of the Phase 2A
core is preserved: the trading code is concrete subclasses layered on top.

### 3. The Risk Gate is pure domain, and a veto collapses to safe inaction

`RiskGate` lives in `engines/risk_engine/domain`, is deterministic and
LLM-free, and is the *only* path from a `TradeProposal` to an `ApprovedTrade`
— enforced by a module-private capability token, so an approved trade cannot
be forged (illegal states unrepresentable, Standing Rule 5).

The generic `Decision` type forbids "act on an actionable conclusion over an
unacceptable risk" by construction. A gate veto therefore has exactly one
honest representation: the **epistemic** `Conclusion` still records that the
reasoning favored a trade, while the **pragmatic** `Decision` collapses to a
safe stand-aside carrying the veto reasons. `CognitiveState.acted` is `False`.
This is the Part-II §8 "Risk Gate is a hard constraint, not a debate
participant" made concrete.

### 4. The Chief Decision Agent: LLM judgment, deterministic numbers

The chief is LLM-backed (CA §8 reserves the most capable model for it), but:

- its confidence **level** is copied from the deterministic `ConfidenceReport`,
  never invented by the model (Standing Rule 4 — deterministic numbers, LLM
  narration on top);
- an actionable pick whose synthesized confidence is below `MODERATE`
  **collapses to inaction** (CC §6, action bias is a bug), in code, not by
  prompt;
- on model failure or an unusable choice, it **degrades explicitly** to the
  deterministic reference synthesizer and records that in the trace, rather
  than aborting a run over a transient hiccup.

### 5. Persistence: SQLite + an explicit `from_document` deserializer

The serialization contract (Phase 2A) deferred deserialization to "the first
persistence adapter." That is now: `SqliteReasoningTraceRepository` stores the
full `to_document` JSON (plus promoted columns for listing), and
`trace_from_document` reconstructs the frozen trace tree with one explicit
builder per type, each failing loudly on an unrecognized shape. Append-only is
enforced by the schema (primary key); a second write of an id raises.
`schema_version` travels in every record for future upcasting.

### 6. Incidental: structlog logger caching turned off

`configure_logging` no longer sets `cache_logger_on_first_use=True`. A cached
module-level logger bound under one test's configuration defeats
`structlog.testing.capture_logs` in another; for a local CLI the caching is a
negligible optimization, and observability of our own logs is worth more.

## What this slice deliberately does not do

Live-chart validation (the exit criterion's "≥3 real charts") requires a key
and real images; here the same three outcomes — a setup acted on, an honest
no-clear-edge, and a gate veto — are proven **offline** through scripted
providers, and the live path is exercised by the trader. Per-role *model*
selection is config-shaped but ships as a single model for all roles; richer
market-domain modeling, real doctrine grounding (Knowledge Engine, Phase 4),
and prompt evaluation (Phase 6) are later phases by design.
