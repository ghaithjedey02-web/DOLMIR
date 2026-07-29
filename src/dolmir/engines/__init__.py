"""The bounded contexts (CA §4): market, journal, risk, memory, knowledge, trader.

Each engine owns domain/ + application/ + adapters/ internally; the
inter-engine dependency graph (CA §3.2) is enforced by import-linter.
"""

__all__: list[str] = []
