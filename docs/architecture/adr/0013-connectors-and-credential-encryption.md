# ADR-0013 — Connector ports, encrypted per-tenant credentials, and the first mailbox provider

**Status:** Accepted · **Date:** 2026-09-03

## Context

Direction §15 asks for a connector abstraction so integrations can be added without rewriting Core; §18 requires encrypted secrets and tenant isolation. The owner (OD-11) wants both Google Workspace and Microsoft 365 supported through one abstraction, but not implemented simultaneously, and asked for the fastest reliable path to a production-quality first implementation.

## Decision

1. `connectors` is a Core module. Ports are per capability, not per vendor: `MailboxConnectorPort` (list new messages since a cursor, fetch raw MIME with attachments, send, test), later `RecordImportPort`, `DriveConnectorPort`. Adapters implement ports; Core never names a vendor.
2. `tenant_connections` stores one connection per tenant and capability: provider, display name, non-secret settings, **encrypted credentials**, sync state (cursor), status, last error. Credentials are AES-256-GCM under `DOLMIR_SECRETS_KEY` (32 bytes, base64, a boot-time secret), with a random nonce per record and the tenant id as associated data, so a ciphertext cannot be replayed into another tenant. Plaintext exists only inside the connectors module; the API never returns it; audit entries record changes without values.
3. First inbound paths: (a) a **raw MIME ingestion endpoint** signed with per-tenant HMAC (timestamp + nonce + body, replay-protected) — provider-agnostic, works with forwarding rules, n8n nodes or scripts, testable offline; (b) an **IMAP/SMTP adapter** (`imapflow`, `nodemailer`) as the first pull/send provider, because IMAP is the common denominator of Workspace, Microsoft 365 (XOAUTH2) and hosted providers used by Italian SMEs. Gmail API and Microsoft Graph adapters follow behind the same port when a customer requires them.
4. Every connector call runs inside a tenant scope; polling is scheduled per connection through the job queue; outbound sends happen only from an approved recommendation, carry an idempotency key, and are audited.
5. Live verification against a real mailbox is a deployment task (Phase 3); until then the adapter is tested against a fake client and the ingestion endpoint against `.eml` fixtures. This limitation is stated wherever the adapter is documented.

## Why

Speed with honesty: the endpoint delivers value immediately with zero OAuth setup; IMAP covers the widest set of mailboxes with one adapter; the port keeps the second and third providers Core-neutral.

## Alternatives considered

- Gmail API first — best for Workspace, useless for Microsoft 365 and hosted providers, needs a Google Cloud OAuth application before the first message flows.
- Microsoft Graph first — the mirror image.
- n8n as the only integration path — leaves credentials and logic outside DOLMIR's audit and tenancy (ADR-0009).

## Consequences

- A new provider is an adapter plus the shared contract suite for the port.
- `DOLMIR_SECRETS_KEY` becomes a required secret wherever connections exist; key rotation is a re-encryption job (documented, not yet built).
