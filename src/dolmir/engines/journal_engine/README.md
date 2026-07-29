# Journal Engine

Bounded context. Boundaries per `Docs/architecture/DOLMIR_FOUNDATION.md`, Core Architecture §4.

**Owns:** The immutable, append-only ledger: every trade, decision, and outcome, timestamped. The ground truth every learning mechanism reads.

**Explicitly does not own:** Any *interpretation* of that data — behavioral patterns are Trader Engine's job; distilled experience is Memory Engine's.

**Depends on (engines):** none — leaf of the engine graph (enforced by import-linter).

**Standing rules that bite here:** the repository port exposes no update/delete — append-only is a type-level fact, not a convention (CA §6); every persisted record carries `schema_version` (Standing Rule 6).
