# Agent-quality evals

Golden-dataset regression scenarios measuring whether agents are *good at
their jobs* — a fundamentally different question from code correctness
(Core Architecture §18).

A contract test asks "does `AnthropicAdapter` implement `LLMProviderPort`
correctly?"; an eval asks "does the ICT Specialist actually identify order
blocks well?" — the latter needs labeled historical scenarios and scoring
rubrics, not assertions.

The harness and first datasets land in Phase 6 (`Docs/ROADMAP.md`). Evals
run locally and on-demand in CI — not per-commit — because they call real
models and cost real money.
