# Memory Engine

Bounded context. Boundaries per `Docs/architecture/DOLMIR_FOUNDATION.md`, Core Architecture §4/§11.

**Owns:** Episodic memory (indexed, searchable record of past analyses + outcomes — Phase 5) and Semantic memory (generalizations distilled *from* episodes over time — Phase 12, deliberately deferred until real data exists).

**Explicitly does not own:** Curated external doctrine (Knowledge Engine — different provenance, different trust); ephemeral in-flight analysis state (that's Orchestration's `GraphContext`, not memory).

**Depends on (engines):** Journal (read). Enforced by import-linter.

**Standing rules that bite here:** Rule 6 (`schema_version` on every episode — this data must survive a decade of schema evolution); Memory Principles (EC §5): structured, auditable, explainable, user-controlled (export/delete on the port from day one).
