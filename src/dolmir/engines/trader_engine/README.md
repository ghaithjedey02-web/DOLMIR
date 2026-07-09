# Trader Engine

Bounded context. Boundaries per `Docs/architecture/DOLMIR_FOUNDATION.md`, Core Architecture §4.

**Owns:** The `TraderProfile`: psychology, discipline, risk tolerance, recurring mistakes, preferred sessions/setups — every field with provenance back to the episodes/statistics that produced it (Phase 9).

**Explicitly does not own:** Raw event logging (Journal Engine's job).

**Depends on (engines):** Journal, Memory (read). Enforced by import-linter.

**Standing rules that bite here:** psychology *modulates* size/confidence at Risk Evaluation only — it never votes on what the market is doing (Cognitive Constitution §10, Cognitive Architecture §9); profile claims are Assumptions with minimum-N gates, never Facts (CC §8); the trader can always view, export, and delete this data (EC §5).
