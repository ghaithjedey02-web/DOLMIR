# Knowledge Engine

Bounded context. Boundaries per `Docs/architecture/DOLMIR_FOUNDATION.md`, Core Architecture §4/§12.

**Owns:** Curated ICT/SMC/psychology/risk doctrine and its retrieval (RAG). Content lives in `knowledge_base/` (versioned markdown); this engine owns ingestion, indexing, and `KnowledgeRepositoryPort.search()`.

**Explicitly does not own:** Anything derived from *this trader's own* experience — that's Memory Engine. Five losing trades must never mutate the definition of a breaker block (CA §11).

**Depends on (engines):** none — leaf of the engine graph (enforced by import-linter).

**Standing rules that bite here:** Knowledge Principles (EC §6): doctrine is separated from reasoning, evolves independently of code, and supports multiple domains — ICT/SMC is the first framework, not the last.
