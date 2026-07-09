# Contract tests

One shared test suite per Port, run against **every** adapter that claims to
implement it (Core Architecture §18). This is what makes "swappable" a
verified property instead of a hope: when the OpenAI adapter arrives in
Phase 11, it must pass the exact suite the Anthropic adapter passed in
Phase 2.

The first real suite (`LLMProviderContractTests`, cassette-based) lands with
the first LLM adapter in Phase 2 — see `Docs/ROADMAP.md`.

Distinct from `tests/evals/`: contract tests verify an adapter implements a
port correctly; evals measure whether an agent is any good at its job.
