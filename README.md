# DOLMIR

**An AI-native Trader Operating System.** DOLMIR models two things
simultaneously — the market (ICT/Smart-Money-Concepts as the first
analytical framework) and the trader (a long-term behavioral and
psychological profile) — and reasons about them through an explainable,
multi-agent cognitive pipeline that learns from its own record over months
and years. It is explicitly **not** a signal service, not an auto-trading
bot, and never a black box: every conclusion traces back to the evidence
and reasoning that produced it, and the human is always the final
decision-maker.

## Canonical documents

| Document | Role |
|---|---|
| [`Docs/architecture/DOLMIR_FOUNDATION.md`](Docs/architecture/DOLMIR_FOUNDATION.md) | **The law of the project.** Engineering Constitution, Core Architecture, Cognitive Constitution, Cognitive Architecture. Every engineering decision must respect it. |
| [`Docs/ROADMAP.md`](Docs/ROADMAP.md) | The official execution plan: 15 phases from kernel skeleton to V1.0. |
| [`Docs/architecture/adr/`](Docs/architecture/adr/) | Architecture Decision Records — one file per major decision. |

Current status: **Phase 2B** — the first vertical slice: `dolmir analyze`
runs one real, explainable trading analysis end-to-end (chart perception →
ICT/SMC understanding → falsifiable hypotheses → agent debate → deterministic
Risk Gate → explained, persisted decision) on the Phase 2A reasoning engine.
See [ADR 0001](Docs/architecture/adr/0001-first-vertical-slice.md) and the
roadmap.

## Quickstart

Requires Python **3.12+**.

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

dolmir version
dolmir doctor      # boots the kernel with zero external infrastructure

# The full quality gate (identical to CI):
ruff check . && ruff format --check . && mypy && lint-imports && pytest
```

### Analyzing a chart

`analyze` needs a model (the reasoning engine and Risk Gate run offline, but
the agents call an LLM). Supply a key, then point it at a chart image:

```bash
export DOLMIR_LLM__API_KEY=sk-ant-...      # your Anthropic key
dolmir analyze --image path/to/chart.png   # perceive → reason → decide, and persist the trace
dolmir trace show --id <trace-id>          # reconstruct the reasoning behind any past decision
```

Every analysis prints a trader-legible explanation, the risk-gated decision
(including an honest "no clear edge" or a Risk-Gate veto), the per-run LLM
cost, and a trace id. Without a key, `analyze` fails loudly and legibly; the
whole pipeline is still exercised offline by the test suite (scripted
providers and cassettes — no network, no key).

Configuration comes from `DOLMIR_*` environment variables and an optional
`.env` file (nested fields use `__`, e.g. `DOLMIR_PLUGINS__ENABLED`,
`DOLMIR_LLM__MODEL`, `DOLMIR_RISK__MIN_REWARD_TO_RISK`). Secrets are env-var
only. Invalid configuration fails loudly at boot, by design.

## Repository map

```
src/dolmir/            the installable package (src layout)
  kernel/              shared substrate: Result, EntityId, events, clock,
                       event bus, config, plugin system, logging
  orchestration/       the scheduler — Reasoning Graph, agents, traces (Phase 2+)
  engines/             bounded contexts: market, journal, risk, memory,
                       knowledge, trader (each: domain/application/adapters)
  providers/           cross-engine adapters: llm, vision, embeddings
  delivery/            driving adapters: cli (api in Phase 14)
knowledge_base/        curated trading doctrine — content, not code
tests/                 unit / integration / contract / evals
Docs/                  the canonical documents above + ADRs
```

**Layout note:** the Core Architecture's tree (`kernel/`, `engines/`, …)
is realized under `src/dolmir/` so imports are namespaced
(`dolmir.kernel…`, `dolmir.engines…`) rather than polluting the top-level
module namespace; src layout also prevents accidental
import-from-working-directory.

## Architecture is enforced, not suggested

`pyproject.toml` carries import-linter contracts encoding the layer rule
(domain ← application ← adapters) and the engine dependency graph. CI runs
them on every push: **an architectural violation is a failing build.** See
the foundation document, Core Architecture §3.
