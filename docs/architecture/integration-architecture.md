# Integration architecture

DOLMIR is an intelligence and automation layer over the systems a company already uses (Product Master Direction §8, §15). It is not the system of record for accounting, inventory, ERP master data or payroll. It keeps event history, evidence, derived intelligence, AI state, workflow state, projections and company memory.

## Connector abstraction (designed; first implementation in Phase 2)

Integrations are a Core capability behind ports, with per-tenant encrypted credentials, tenant isolation and audit on every side effect:

| Kind     | Port (planned)         | First implementation                                                    | Rule                                                                                                                                           |
| -------- | ---------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound  | `MailboxConnectorPort` | Gmail API or IMAP (decided with the first company, OD-13)               | Raw message and attachments stored as content-addressed objects; a `DocumentReceived` ledger event with provenance; then DOLMIR's own pipeline |
| Inbound  | `RecordImportPort`     | CSV / ERP export of customers                                           | Deterministic import with evidence (source file, row)                                                                                          |
| Outbound | `MessageDeliveryPort`  | SMTP / Gmail send                                                       | Only after a persisted human approval exists; idempotent; audited                                                                              |
| Runtime  | n8n, pg-boss           | pg-boss for in-process jobs; n8n optional for external triggers (OD-14) | n8n never writes to DOLMIR tables and never holds domain logic (ADR-0009)                                                                      |

Every connector call runs under a tenant scope, so a connector can never read or write another tenant's data even by mistake.

## Machine callers

Services (n8n workflows, schedulers) authenticate with per-tenant HMAC-signed requests (timestamp + nonce + body, replay-protected), mapped to a tenant server-side. The signing utility and the first ingestion endpoint ship with the mailbox connector. Users authenticate with JWTs from the identity provider (Supabase Auth in production; the dev issuer locally).

## What exists today

- The `SourceKind` vocabulary of the ledger (`DOCUMENT`, `EMAIL`, `ERP`, `USER`, `SYSTEM`, `AI`, `INTEGRATION`) and mandatory provenance on every event.
- `ObjectStoragePort` (content-addressed, tenant-prefixed) for raw documents and attachments.
- The `ActorType.SERVICE` actor for machine callers in audit and provenance.
- Zero n8n workflows and zero connectors, on purpose: they are built with the first end-to-end workflow, against a real company's systems.

## Boundaries that will not move

1. DOLMIR owns classification, extraction, verification, entity resolution, reasoning, approval policy and memory. A workflow tool that needs a business rule calls DOLMIR.
2. External side effects happen only after a persisted approval, through an outbound port, with an idempotency key and an audit entry.
3. External links found in documents are never fetched automatically; untrusted content is data.
