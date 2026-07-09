"""DOLMIR — an AI-native Trader Operating System.

Canonical design reference: ``Docs/architecture/DOLMIR_FOUNDATION.md``.
Execution plan: ``Docs/ROADMAP.md``.

Package layout (Core Architecture §5):

- ``dolmir.kernel`` — tiny, high-change-control shared substrate.
- ``dolmir.orchestration`` — the scheduler; runs agents through the Reasoning
  Graph. Not a bounded context.
- ``dolmir.engines`` — the bounded contexts (market, journal, risk, memory,
  knowledge, trader).
- ``dolmir.providers`` — cross-engine infrastructure adapters (LLM, vision,
  embeddings).
- ``dolmir.delivery`` — driving adapters (CLI now, API later).

The dependency rules between these packages are enforced mechanically by
import-linter contracts in ``pyproject.toml`` — see Engineering
Constitution §3.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
