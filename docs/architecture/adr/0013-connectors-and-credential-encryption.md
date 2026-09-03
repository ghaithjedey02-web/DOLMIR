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

## Implementation notes (2026-09-03)

- An e-mail document stores the **raw MIME** it arrived as, so its content hash is the hash of the message itself and the text can always be derived again. Readable text comes from an extractor behind the documents module's `TextExtractorPort`: part 0 is the subject, part 1 the body, preferring the plain-text alternative and otherwise converting the HTML with the platform's own converter, which drops scripts, styles and markup. Attachments become child documents with their own bytes, hashes and extraction status; a format no extractor supports is recorded as `unsupported`, never silently skipped.
- Inbound mail is untrusted input, and the code says so. Message and attachment documents carry `trust: 'untrusted_external'` in their metadata, sizes and attachment counts are bounded, and filenames are treated as labels rather than paths. Storage keys stay content-addressed and are never derived from a filename.
- `connections:manage` is **human-only**, alongside `decisions:approve` (ADR-0011). A model that reads "add this mailbox" or "rotate this key" in a message has no path to acting on it, whatever role it acts on behalf of. `connections:read` returns metadata only; no code path returns credentials to a caller. The one exception is the ingestion key, shown once at creation because it must be configured on the other side, and rotated rather than recovered.
- Polling is idempotent by construction: the cursor advances only over messages that were ingested, and the source reference `mailbox:<connection>:<generation>:<uid>` makes a re-poll a duplicate rather than a second document. A provider that renumbers its messages changes the generation, which resets the cursor and re-reads the mailbox; the same message then arrives under a new source reference and is recognised by its `Message-ID`.
- Signature verification takes the request headers under the names the transport carries, so no caller translates between HTTP names and internal ones. An unknown key, a disabled key and another tenant's key give the same answer, so a caller learns nothing about other tenants.
- The first poll of a new connection starts at the mailbox's next message. Connecting a mailbox does not ingest its history; a lookback window is an explicit per-connection setting.
