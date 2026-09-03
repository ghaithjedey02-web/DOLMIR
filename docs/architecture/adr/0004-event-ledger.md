# ADR-0004 — Operational facts live in an append-only event ledger; state is projected

**Status:** Accepted 2026-09-03 (implemented: `ledger_events`, `EventLedger`, `ProjectionRunner`, append-only enforcement tested) · **Date:** 2026-09-02

## Context

Directive §3 (law 1) and §12: DOLMIR must be able to explain _why_ it believes a current state ("60 m available") by pointing at the events and sources that produced it, must distinguish `acquistato`, `documentato`, `ricevuto`, `disponibile`, and must be able to treat a divergence between its own event-derived view and the ERP as a finding. A mutable `stock = 15` row cannot do any of that.

## Decision

1. Operational facts are recorded as **immutable events** in `ledger_events`: tenant, stream (`stream_type`, `stream_id`, `stream_sequence`), global sequence, `event_type`, `schema_version`, `payload`, **mandatory `provenance`** (source kind and reference, actor, evidence references, recorder), `occurred_at`, `recorded_at`, `correlation_id`, `causation_id`, and a per-tenant `idempotency_key`.
2. The table is append-only: `UPDATE` and `DELETE` are revoked from the runtime role and rejected by a trigger for every role.
3. Appends use **optimistic concurrency** (expected stream version) so two writers cannot silently interleave.
4. **Current state is a projection** rebuilt from events; projections record their checkpoint (`projection_checkpoints`) and can be dropped and rebuilt. Projections are read models, never sources of truth.
5. Corrections are new events (e.g. `QuantityCorrected` with provenance), never edits.
6. The **audit log** (who did what to the system) and the **event ledger** (what happened in the business) are distinct artifacts with distinct tables; neither replaces the other.

## Why

Traceability and explainability are product requirements, not nice-to-haves. Append-only facts with provenance make "Why is DOLMIR telling me this?" answerable from data, make the material shadow ledger possible, and make outcome memory possible later (decision → expected → actual).

## Alternatives considered

- Mutable entity tables with an audit trail — the trail explains _changes_, not _beliefs_; conflicts between sources cannot be represented.
- A dedicated event-store product (EventStoreDB, Kafka) — operational weight far beyond a modular monolith's needs; PostgreSQL gives transactions, RLS and the ledger in one place.
- Full transactional outbox and relay in Phase 0 — unnecessary for a single process; the outbox pattern is added when a second process consumes events.

## Consequences

- Every module that records business facts appends events and maintains its projections; schema evolution uses `schema_version` and upcasters.
- Query patterns that need current state read projections; historical questions read the ledger.
- Storage grows monotonically; retention and archival policies are a later, documented decision (GDPR erasure is handled by crypto-shredding or tombstone events, to be decided when personal data enters the ledger).
