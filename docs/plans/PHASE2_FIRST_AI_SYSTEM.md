# Phase 2 — Commercial Inbox Intelligence as the first complete vertical slice over DOLMIR Core

**Status:** Design accepted by the owner's decisions of 2026-09-03 (OD-10 … OD-14); implementation in progress on branch `claude/dolmir-foundation-architecture-784tn2`. **Constraint from the owner:** the first system proves the whole DOLMIR architecture; it is not the definition of DOLMIR and DOLMIR is not an e-mail-management SaaS.

## 1. The chain every AI System runs

```
INGEST → UNDERSTAND → RESOLVE → REASON → EVIDENCE → RECOMMEND → HUMAN APPROVAL → ACTION → OUTCOME
```

The chain is implemented **once, in Core**, as generic primitives. An AI System contributes only the parts that are specific to its domain (what to look at, how to interpret it, what to recommend, which act tools it offers). The table says what is Core and what is System for the first system, and what a second system (procurement documents, material intelligence…) reuses unchanged.

| Stage          | Core primitive (reusable)                                                                                                                                                                                                                                                                                                                    | Commercial Inbox Intelligence contributes                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| INGEST         | `documents` module: any artefact (e-mail, attachment, file, record export) stored content-addressed, text extracted with offsets, `DocumentReceived` on the ledger; `connectors` module: per-tenant connections with encrypted credentials, canonical inbound messages, HMAC-signed ingestion endpoint for machine callers; `jobs` (pg-boss) | a mailbox connection (IMAP/SMTP first; Gmail API and Microsoft Graph later behind the same port); the MIME → documents mapping |
| UNDERSTAND     | `LlmProviderPort` with structured output; evidence-span verification (a quoted span must exist at the stated offsets); company profile, rules and terminology as context                                                                                                                                                                     | deterministic classification signals; the request-field extraction schema; the classification prompt                           |
| RESOLVE        | `entities` module: customers, suppliers, contacts, products with aliases (e-mail, domain, VAT, code, name); `EntityResolver` → `Determination<Entity>` with candidates and reasons, or NON_DETERMINATO                                                                                                                                       | uses the resolver with the sender's address and signature                                                                      |
| REASON         | `Claim` with `EpistemicStatus`; `NON_DETERMINATO`; deterministic rule evaluation (rules are versioned per company)                                                                                                                                                                                                                           | completeness, body-vs-attachment conflicts, urgency, language                                                                  |
| EVIDENCE       | `Evidence` (document spans, record fields, computations) attached to every finding; audit and ledger provenance                                                                                                                                                                                                                              | cites message and attachment spans and customer records                                                                        |
| RECOMMEND      | `cases` module: a case (attention item) with findings, determination, priority and **recommendations** = a tool name + validated input + rationale + resolved policy level                                                                                                                                                                   | reply asking for missing information / acknowledge and route / no action; a grounded draft reply                               |
| HUMAN APPROVAL | approvals on recommendations by a human with `decisions:approve` (never an AI actor); persisted; audited                                                                                                                                                                                                                                     | —                                                                                                                              |
| ACTION         | `ActionRunner`: executes the approved recommendation through `ToolExecutor` with the approval reference; idempotent; `ActionExecuted` on the ledger                                                                                                                                                                                          | the `send_reply` act tool over the mailbox connector                                                                           |
| OUTCOME        | `OutcomeRecorded` events; case metrics projection (time to answer, unanswered requests, approvals vs rejections)                                                                                                                                                                                                                             | outcome kinds: replied, acknowledged, routed, dismissed                                                                        |
| AGENT          | tool-using conversation over the same tools (read, analyze, draft; act only through approvals); conversation persisted per tenant                                                                                                                                                                                                            | system tools registered into the shared registry                                                                               |
| DASHBOARD      | `apps/web`: attention, case detail with evidence, approvals, agent, activity, AI usage, settings                                                                                                                                                                                                                                             | nothing system-specific beyond labels                                                                                          |

## 2. The AI System contract (ADR-0012)

```ts
interface AiSystemDefinition {
  readonly key: string; // 'commercial_inbox'
  readonly name: string;
  readonly version: number; // bumped with behaviour changes; recorded on every case
  readonly triggers: { readonly documentKinds: readonly string[] }; // which ingested documents it analyses
  readonly tools: readonly AnyToolDefinition[]; // registered into the shared ToolRegistry
  analyze(
    input: AnalysisInput,
    context: SystemContext,
  ): Promise<Result<CaseDraft | null, DomainError>>;
}
```

`AnalysisInput` carries the document (with texts and children), the company configuration and the tenant; `SystemContext` carries the provider port, the entity resolver, the clock and a logger. `CaseDraft` is what Core turns into a case: kind, title, summary, priority, determination (`READY_FOR_REVIEW` | `NON_DETERMINATO` | `NOT_APPLICABLE`), findings (`Claim[]` with evidence), the NON_DETERMINATO account when there is one, and recommendations (`{ tool, input, rationale }`). Returning `null` means "not for this system". Core validates every recommendation's input against the tool's schema before it is stored, so a system cannot propose an action it cannot execute.

Systems are workspace packages `packages/systems/<key>` (`@dolmir/system-<key>`) that depend on `@dolmir/core` only (dependency-cruiser enforces it). The API composition root registers the systems a deployment ships.

## 3. Case engine (Core, `cases` module)

State is derived from ledger events (ADR-0004) with a **synchronous projection**: each use case appends the event and applies the projection in the same transaction, and `ProjectionRunner.rebuild` can recreate the tables from the ledger. Events (stream `case/<id>`): `CaseOpened`, `FindingRecorded`, `RecommendationProposed`, `RecommendationApproved`, `RecommendationRejected`, `ActionExecuted`, `ActionFailed`, `CaseResolved`, `OutcomeRecorded`. Tables: `cases`, `case_findings`, `recommendations`, `approvals` (append-only), `actions` (append-only).

Lifecycle: `open` → (`awaiting_approval` when a recommendation needs one) → `resolved` | `dismissed`. A recommendation's policy level is resolved when it is proposed (tenant override → default) and recorded; `AUTO_EXECUTE` recommendations run immediately, `REQUIRE_APPROVAL` wait, `SUGGEST`/`DRAFT` are shown but never executed by the platform.

## 4. Connectors and the first mailbox provider (ADR-0013)

Decision for OD-11: keep `MailboxConnectorPort` provider-agnostic (list new messages since a cursor, fetch a message with attachments as raw MIME, send a message, test the connection) and ship **two inbound paths and one provider first**:

1. **Raw MIME ingestion endpoint** (`POST /v1/orgs/:orgId/ingest/messages`, HMAC-signed): provider-agnostic from day one. Gmail and Microsoft 365 forwarding rules, n8n's Gmail/Outlook nodes, or any script can deliver messages today, with no OAuth application to register. Fully testable offline with `.eml` fixtures.
2. **IMAP + SMTP adapter** (`imapflow`, `nodemailer`) as the first pull/send provider: it is the common denominator of Google Workspace (app password or XOAUTH2), Microsoft 365 (XOAUTH2) and the hosted providers common among Italian SMEs. Credentials are stored encrypted per tenant. **Honesty:** the adapter is unit-tested against a fake client; verification against a live mailbox needs a real account and is a Phase 3 task.
3. Gmail API and Microsoft Graph adapters come next, behind the same port, when a customer's stack requires them. Nothing in Core changes.

Credentials: AES-256-GCM with a key from `DOLMIR_SECRETS_KEY` (32 bytes, base64), a per-record random nonce, the tenant id as associated data; plaintext never leaves the connectors module; audit records connection changes without values.

## 5. Jobs (ADR-0014)

pg-boss in the same PostgreSQL, in its own schema, behind `JobQueuePort` (enqueue with idempotency keys, work, schedule). Jobs are small and idempotent: `mailbox.poll` (per connection, scheduled), `document.analyze` (per document), `action.execute` (per approved recommendation). A job handler runs inside the tenant scope it was enqueued for; cross-tenant scheduling runs in system scope and is audited. An in-memory adapter serves tests and the e2e chain.

## 6. Company configuration (memory that is structured and governed)

`workspace` module: `company_profile` (name, sector, languages, timezone, signature), `company_rules` (typed, versioned: reply language, SLA hours, auto-acknowledge, estimator routing…), `terminology` (company words → canonical meaning), `tenant_policy_overrides` (persisted `ActionPolicy`). Everything is per tenant, RLS-forced, audited on change, and read by systems as evidence-bearing context — never a free-text prompt blob and never a vector store presented as memory.

## 7. Agent

`converse()` on the provider port carries tool definitions and tool results; `AgentRunner` loops (bounded by turns and cost) calling tools only through `ToolExecutor`, so the agent inherits permissions, policy and audit. Conversations persist per tenant. The agent can read, analyse and draft; it can act only by proposing a recommendation that a human approves.

## 8. Milestones

| #   | Milestone                                                            | Verification                                                                 |
| --- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| M1  | this document, ADR-0012/13/14, systems package rules                 | review                                                                       |
| M2  | `documents` module                                                   | unit + integration (RLS, dedupe, evidence spans)                             |
| M3  | `entities` module + resolver + import                                | unit + integration                                                           |
| M4  | `workspace` module + persisted action policy                         | unit + integration                                                           |
| M5  | `cases` module + AI System registry + approvals + actions + outcomes | unit + integration (rebuild from ledger)                                     |
| M6  | `connectors` + `jobs`                                                | unit (fake IMAP/SMTP), integration (encryption, HMAC), pg-boss on PostgreSQL |
| M7  | `packages/systems/commercial-inbox`                                  | unit with the fake provider; synthetic Italian fixtures; eval skeleton       |
| M8  | API endpoints + composition + e2e of the whole chain                 | e2e: ingest → case → approve → send (fake mailbox) → outcome                 |
| M9  | agent                                                                | contract (tool turns) + e2e                                                  |
| M10 | `apps/web`                                                           | typecheck/lint in CI; manual walkthrough                                     |
| M11 | documentation and report                                             | docs match code                                                              |

## 9. What stays out

Autonomous pricing, drawing interpretation, ERP write-back, sending anything without a persisted approval, a second mailbox provider before the first is verified live, and any warehouse-specific model. Material intelligence remains a future system with its own evidence vocabulary.
