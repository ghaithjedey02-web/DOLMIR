# ADR-0009 — n8n is an orchestration and integration layer, not the domain core

**Status:** Accepted, amended 2026-09-02 (see below) · **Date:** 2026-09-02

## Context

Directive §16: n8n is connected and may handle triggers, webhooks, integrations, scheduled jobs, external API orchestration, synchronisation, notifications and workflow execution. DOLMIR remains the source of domain logic, canonical models, verification, decisions, audit, memory and policy. No DOLMIR workflows exist in n8n today.

## Decision

1. **Inbound:** n8n delivers external events (new email, ERP export, schedule tick) to DOLMIR **ingestion endpoints**. Requests are authenticated with per-tenant HMAC signatures over timestamp + nonce + body, replay-protected, and mapped to a tenant server-side. DOLMIR stores the raw payload as a document, appends a ledger event and runs its own pipeline. n8n never writes to DOLMIR's database.
2. **Outbound:** DOLMIR emits notifications and webhooks for decisions; n8n performs external side effects (send an email, create an ERP record) **only after** a persisted human approval exists in DOLMIR for that action. Every outbound action carries an idempotency key and is audited on both sides.
3. **No domain logic in n8n:** classification, extraction, verification, entity resolution, reasoning, approval policies and memory never live in n8n nodes. A workflow that needs a business rule calls DOLMIR.
4. **MCP hygiene:** only explicitly approved workflows are MCP-enabled; destructive n8n operations require explicit approval; node configuration follows official n8n documentation and tooling, never guesswork.
5. Phase 0 delivers this boundary as documentation plus the request-signing utility; the first endpoints ship with the first vertical slice.

## Why

n8n is excellent at connecting systems and terrible as a system of record: its state is workflow-local, its logic is not versioned with the product, and it cannot enforce tenant isolation, epistemic honesty or the human gate. Keeping the boundary explicit makes n8n replaceable and keeps every consequential action inside DOLMIR's audit and approval model.

## Alternatives considered

- Build workflows primarily in n8n with DOLMIR as a helper API — fast demos, unmaintainable product; violates Directive §16 and §26.
- No n8n; build every connector natively — slower to reach real mailboxes and ERPs; n8n's connector catalogue is exactly the leverage wanted for integrations.

## Consequences

- Connector work in n8n is configuration; every connector still ends in a DOLMIR ingestion contract.
- Integration tests for the boundary use recorded webhook payloads, not a live n8n instance.

## Amendment (2026-09-02, Product Master Direction)

Integrations are a Core capability behind a **connector abstraction** (Direction §15): mailbox, drive, ERP, CRM and messaging connectors implement DOLMIR ports, hold per-tenant encrypted credentials and are audited. n8n is **one** connector runtime and orchestration option among others (pg-boss for in-process jobs; native connectors where they are commercially important), not the integration strategy. The boundary rules above continue to apply whenever n8n is used: no domain logic in n8n, no direct database writes, every consequential action behind a persisted human approval.
