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

Current status: **Phase 1** (kernel skeleton, primitives, and architectural
enforcement) — see the roadmap.

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

Configuration comes from `DOLMIR_*` environment variables and an optional
`.env` file (nested fields use `__`, e.g. `DOLMIR_PLUGINS__ENABLED`).
Invalid configuration fails loudly at boot, by design.

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
