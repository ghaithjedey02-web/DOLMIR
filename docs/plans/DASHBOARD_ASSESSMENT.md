# DOLMIR Dashboard — assessment and product architecture (Stages 1–2)

**Status:** assessment for the owner's review before any dashboard code is written. **Date:** 2026-09-05. **Branch:** `claude/dolmir-dashboard-oqrrnm`, fast-forwarded from `claude/dolmir-foundation-architecture-784tn2` at `3c998fb`; this document is the only change. **Mission:** the owner's dashboard brief of 2026-09-05 (the "DOLMIR — DASHBOARD" master context): understand DOLMIR, the software and the user; design the operating experience; then implement. Markers as in every plan here: **[CONFIRMED]** verified in the repository or a named source; **[HYPOTHESIS]** reasoned, needs the owner's confirmation; **[UNKNOWN]** not determinable here.

The brief asks fifteen questions. They are answered in order. Nothing below describes a screen as if it existed; everything below describes what the code can support today and what it cannot.

---

## 1. Current repository and frontend state

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Marker      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| This repository holds `packages/core`, `packages/systems/commercial-inbox` and `apps/api`. **There is no `apps/web`, no React, Next.js or Tailwind dependency, no UI code and no design token.** `docs/demo.md` §8 states it plainly: "There is no dashboard yet. The API and the CLI are the whole surface."                                                                                                                                                                           | [CONFIRMED] |
| The plans reserve the dashboard here: OD-12 confirmed on 2026-09-03 ("`apps/web` here — same types, same CI"); roadmap step 2g; milestone M10 "`apps/web` — typecheck/lint in CI; manual walkthrough". The stack ("Next.js, React, Tailwind") is recorded as a **hypothesis** with "decision needed only when Phase 2 starts" (`PRODUCT_DIRECTION_ALIGNMENT.md` §5.8). No information architecture exists.                                                                              | [CONFIRMED] |
| Local gates on this branch are green: `pnpm check` (typecheck, ESLint, Prettier, dependency-cruiser over 243 modules) and 281 unit tests. Integration, contract, architecture and e2e projects were not run here (no PostgreSQL daemon in this sandbox; the server binaries exist, so a later stage can start a local cluster).                                                                                                                                                         | [CONFIRMED] |
| The sibling repository `ghaithjedey02-web/prova_1` is the public site dolmir.com: Next.js 16.3.3, React 19.2.8, Tailwind 4.3.3, App Router, npm workspaces. It carries a documented design system in `apps/web/app/globals.css` ("Officina digitale": dark identity, square corners, "amber means uncertainty", one instrument accent, Archivo / Instrument Sans / IBM Plex Mono). It contains no dashboard.                                                                            | [CONFIRMED] |
| The Founding Brief of 2026-08-29 listed "build the web UI before a client asks" among things not to do in the first 90 days. The owner's OD-12 decision (2026-09-03) and the dashboard brief (2026-09-05) supersede it; the caution behind it — approval must be possible without a UI — is already true: the CLI and the API approve today.                                                                                                                                            | [CONFIRMED] |
| Notion: "DOLMIR OS — Mission Control" (July) is an executive-dashboard concept for the historical Trading OS and is obsolete (ADR-0008). "KPI Dashboard" (Aug 29) is a page for Dolmir the company, not the product. The `Solutions` records promise the customer an "interfaccia di approvazione umana" and a "dashboard di misurazione" whose two measured outcomes are **response time (days → hours)** and **RdO handled per week**, "verifiable by the client on their dashboard". | [CONFIRMED] |
| PR #1 and the Python branch are untouched and irrelevant to this work.                                                                                                                                                                                                                                                                                                                                                                                                                  | [CONFIRMED] |

## 2. Backend and API capabilities relevant to the Dashboard

All routes are in `apps/api/src/http/routes/*.ts`; every tenant route requires a bearer JWT, membership resolved inside the tenant's RLS scope, and a named permission. Errors are RFC 9457 `application/problem+json` with `code`, `detail`, `requestId` and, for client errors, `errors`. Every response carries `x-request-id`, `x-correlation-id`, `cache-control: no-store`. [CONFIRMED]

| Route                                                                                                                  | Permission                                | What the dashboard gets                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/me`                                                                                                           | token                                     | principal (subject, email, displayName, **expiresAt**) and the user's organisations with `roleKey` — the organisation switcher                                                                                                    |
| `GET /v1/orgs/:orgId`                                                                                                  | `organization:read`                       | organisation, membership, **`permissions[]`** for this membership, `roleMatrixVersion` — the one source for showing or hiding UI                                                                                                  |
| `GET /v1/orgs/:orgId/cases?status&kind&systemKey&limit≤200`                                                            | `organization:read`                       | the attention list, ordered **high priority first, then newest**; no paging cursor exposed (the repository supports `before`), no counts                                                                                          |
| `GET /v1/orgs/:orgId/cases/:caseId`                                                                                    | `organization:read`                       | `{ case, findings, recommendations, approvals, actions }` — the whole detail in one call                                                                                                                                          |
| `POST …/recommendations/:id/approve` · `/reject`                                                                       | `decisions:approve`                       | body `{ note?, execute = true }`; returns `{ recommendation, action }` where **`action` is `null` until a worker has run**; refuses `RECOMMENDATION_ALREADY_DECIDED`, and `RECOMMENDATION_NOT_EXECUTABLE` for READ_ONLY / SUGGEST |
| `POST …/cases/:caseId/resolve`                                                                                         | `decisions:approve`                       | `{ resolution: resolved_manually \| dismissed, note? }`; refuses `CASE_ALREADY_CLOSED`, `ACTIONS_PENDING`                                                                                                                         |
| `GET …/documents/:documentId/texts`                                                                                    | `organization:read`                       | the document, its text parts with offsets, its children — what an evidence span points at                                                                                                                                         |
| `GET …/workspace`                                                                                                      | `organization:read`                       | profile, **rule values by key** (rationale and version are flattened away), terminology, `knownRules` (key, description, owner); **policy overrides are not returned**                                                            |
| `PATCH …/workspace/profile` · `PUT …/workspace/rules/:key` · `POST …/workspace/terminology` · `PUT …/workspace/policy` | `workspace:manage`                        | the settings writes; a rule write returns the new version with its rationale                                                                                                                                                      |
| `POST …/entities/import`                                                                                               | `entities:manage`                         | CSV import of customers, suppliers, contacts, products — **the only way to add or alias an entity**                                                                                                                               |
| `GET` / `POST …/connections` · `POST …/connections/ingestion-keys` · `POST …/connections/:id/status` · `/poll`         | `connections:read` / `connections:manage` | connections without credentials (status, lastError, lastSyncAt, settings); an ingestion secret **shown once**; poll a mailbox now                                                                                                 |
| `GET …/audit?limit&before&action`                                                                                      | `audit:read`                              | the audit trail, newest first (actor, action `resource.verb`, target, outcome, details, requestId)                                                                                                                                |
| `GET …/ai-usage?since&limit`                                                                                           | `ai_usage:read`                           | per use case and model: calls, tokens, estimated cost, `unpricedCalls`; recent calls                                                                                                                                              |
| `POST /v1/orgs/:orgId/ingest/messages`                                                                                 | HMAC signature                            | machine ingestion; **not for a browser** (the signing secret must never be in the web app)                                                                                                                                        |
| `GET /health/live` · `/ready`                                                                                          | none                                      | operational readiness (database role, migrations, AI provider) — an operator concern, not a dashboard feature                                                                                                                     |

Identity and session: production verifies JWTs against a JWKS URL (Supabase Auth is the intended issuer, `docs/deployment.md`); outside production the CLI mints HS256 dev tokens (`dolmir dev-token`). **There is no cookie session, no refresh, no logout and no CORS configuration** in the API: a browser on another origin cannot call it today. [CONFIRMED]

Roles and what they can do in a dashboard (`packages/core/src/modules/access/domain/permissions.ts`, matrix v4): [CONFIRMED]

| Capability                                  | owner | admin | operator | viewer |
| ------------------------------------------- | ----- | ----- | -------- | ------ |
| Read cases, findings, evidence, drafts      | yes   | yes   | yes      | yes    |
| Approve, reject, resolve                    | yes   | yes   | yes      | no     |
| Company profile, rules, terminology, policy | yes   | yes   | no       | no     |
| Connections: read / manage                  | yes   | yes   | read     | no     |
| Import entities (CSV)                       | yes   | yes   | yes      | no     |
| Audit trail, AI usage                       | yes   | yes   | **no**   | no     |

What does **not** exist and a dashboard would eventually need: [CONFIRMED]

1. No read endpoint for entities (customers, suppliers, products, aliases) — only CSV import.
2. No members endpoint — approvals carry `decidedBy` as a user id only; the UI cannot name the approver except "you".
3. No paging on cases, no counts; no search.
4. No policy overrides, rule rationale, rule version or rule history in `GET /workspace` (the repository ports have them).
5. No endpoint for the registered AI Systems (`AiSystemRegistry.list()` exists in code).
6. No outcomes or metrics endpoint: the ledger has no endpoint; the "case metrics projection (time to answer, unanswered requests)" of `PHASE2_FIRST_AI_SYSTEM.md` §1 is not built. The two outcomes promised to customers cannot be shown yet.
7. No bearer-authenticated upload of a message or file; ingestion is signature-only or mailbox polling.
8. No agent conversation (M9), no rate limiting, no CORS, no server-sent events.

## 3. Domain entities and workflows the Dashboard will render

Everything below is a Zod-validated type in `packages/core` and is what the API returns (dates as ISO strings over JSON). [CONFIRMED]

| Concept                     | Shape the UI works with                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Case** (attention item)   | `systemKey` + `systemVersion`, `kind` (quote_request, order_request, order_change, customer_question, complaint, follow_up, information_request, supplier_message, other_commercial), `status` (open, awaiting_approval, resolved, dismissed), `priority` (low, normal, high), Italian `title` ("Richiesta di preventivo: Officine Meccaniche Rossi S.r.l."), `summary`, `determination` (READY_FOR_REVIEW, NON_DETERMINATO, NOT_APPLICABLE), `nonDeterminato`, `subjects` (customer / product refs with labels), `openedAt`, `updatedAt`, `resolvedAt`, `resolution` (actioned, dismissed, resolved_manually) |
| **NON_DETERMINATO account** | `subject`, `known` claims, `unknown[]`, `conflicts[]`, `missingInputs[]` (name, description, `resolvableBy` HUMAN / SYSTEM / EXTERNAL), `requiredHumanDecision` (question, options, stake) — the honest outcome as a value, never an error                                                                                                                                                                                                                                                                                                                                                                     |
| **Finding**                 | `statement` (plain sentence: "The message asks for 500 of "flangia tornita S355 DN250 PN16" (Flangia tornita S355 DN250 PN16) requested for 2026-10-15"), `status` FACT / OBSERVATION / ASSUMPTION / HYPOTHESIS, `evidence[]`, `tags` (counterpart, requested_line, delivery_date, requested_information, prompt_injection, draft_refused, unverified_reading)                                                                                                                                                                                                                                                 |
| **Evidence**                | `kind` DOCUMENT_SPAN (document id + `part/start/end` + the verbatim `content`), RECORD_FIELD (entity id + table/field that matched), OBSERVATION, COMPUTATION, CITATION. A span can be re-read through `documents/:id/texts` and highlighted exactly                                                                                                                                                                                                                                                                                                                                                           |
| **Recommendation**          | `tool` (today only `send_mailbox_reply`), `input` (connectionId, to, cc, subject, body, inReplyTo, references — **it is the e-mail as it will leave**), `rationale`, `level` READ_ONLY / SUGGEST / DRAFT / REQUIRE_APPROVAL / AUTO_EXECUTE, `status` proposed / approved / rejected / executed / failed / superseded, `decidedAt`, `decidedBy`, `decisionNote`, `executedAt`                                                                                                                                                                                                                                   |
| **Approval** (append-only)  | decision, decidedBy (user id), note, decidedAt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Action record**           | tool, status succeeded / failed, `result` (messageId, acceptedAt), `error` (code, message), executedAt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Action intent**           | the durable entitlement (pending / sent / failed, attempts, lastError) — **not exposed by the API**; it explains why an approval is "work that will happen" and why the UI must show an in-between state                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Document**                | kind email / attachment / file, filename, contentType, receivedAt, metadata (from, subject, messageId, references, fromDomain), `textStatus` (extracted / unsupported / failed / pending); text parts with offsets                                                                                                                                                                                                                                                                                                                                                                                             |
| **Company configuration**   | profile (legalName, sector, description, languages, timezone, signature, version); rules (core: `reply_language`, `response_sla_hours`, `working_days`, `escalation_contact`; system: `commercial_inbox.acknowledge_quote_requests`, `.quotation_lead_time_days`, `.quotation_customer_commitment_days`, `.ignored_sender_domains`, `.require_known_customer`), each versioned with a rationale; terminology (term, meaning, examples, active); policy overrides (tool or effect → level)                                                                                                                      |
| **Connection**              | capability mailbox / ingest_endpoint, provider (`imap_smtp`, `fake`, `hmac_v1`), displayName, status active / disabled / error, lastError, lastSyncAt, non-secret settings                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Audit entry**             | actor (USER / SERVICE / SYSTEM / AI, id, onBehalfOf), action (`mailbox.message_ingested`, `analysis.completed`, `tool.executed`, `workspace.rule_set`, `connection.created`, `entities.imported`, `system_scope.opened`…), target, outcome success / failure / denied, details, requestId, occurredAt                                                                                                                                                                                                                                                                                                          |
| **AI usage**                | summary rows (useCase, model, calls, tokens, estimatedCost, `priced`, unpricedCalls) and recent records (provider, model, tier, operation, latency, succeeded)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The workflow the dashboard must make legible, as the code runs it: [CONFIRMED]

```
message arrives (signed endpoint or mailbox poll)  →  job document.analyze
  →  case opened: status open, or awaiting_approval when the one recommendation is REQUIRE_APPROVAL
       findings with verified evidence · determination · at most one recommendation (the draft reply)
  →  a human with decisions:approve
       approve  →  entitlement recorded in the same commit  →  job action.execute  →  ActionExecuted
                   →  case resolved (actioned)        or ActionFailed  →  recommendation failed, case stays open
       reject   →  recommendation rejected  →  case dismissed
       resolve  →  resolved_manually or dismissed (refused while an approved action is still executing)
NON_DETERMINATO cases carry no recommendation: a human resolves the identity or the data, then closes the case.
```

Two facts shape the interface more than any other: **the model never sets a business value** (every quantity, date and name in a finding is a verified span or a record field, and readings that did not verify are listed as discarded), and **approval and execution are separate moments** (an approval returns before anything is sent; the reply leaves from a worker and the case reports it afterwards).

## 4. What the Dashboard should expose

Answering the brief's ten questions with data that exists:

| Question                              | Source of truth today                                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What needs my attention?              | cases `awaiting_approval`; open cases with `determination = NON_DETERMINATO` (a human decision is required); recommendations with status `failed`; connections with status `error` |
| What changed?                         | cases by `updatedAt`; recently resolved cases; new approvals and actions                                                                                                           |
| What is important?                    | `priority` (deterministic from intent and urgency), `kind` (a complaint is not a question), age since `openedAt`, the company's `response_sla_hours` rule                          |
| What does DOLMIR know?                | findings as plain statements; subjects (which customer, which product)                                                                                                             |
| Why does DOLMIR believe this?         | the epistemic status of each finding and its evidence: the exact span in the message, the record field that matched, the computation                                               |
| What should I do?                     | the recommendation with its rationale; for NON_DETERMINATO the `missingInputs` (name, what to do, who can resolve it)                                                              |
| What can DOLMIR do for me?            | the recommendation's tool and policy level, in words: "Send this reply through mailbox Vendite, after your approval"                                                               |
| What is waiting for my approval?      | recommendations `proposed` at level REQUIRE_APPROVAL — and only those; DRAFT and SUGGEST are shown as text DOLMIR wrote, never as something to approve                             |
| What happened after previous actions? | approvals (who, when, note), actions (sent at, message id, or the error), case resolution                                                                                          |
| Is anything going wrong?              | failed actions; connection errors with `lastError`; findings tagged `draft_refused`, `prompt_injection`, `unverified_reading`; a mailbox not synced within the SLA window          |

Also exposed, behind a settings area, because the platform is configured through them: company profile, rules with rationale, terminology, what DOLMIR may do (policy levels per tool), connections and ingestion keys, CSV import, and — for owners and admins — what the AI cost, stated honestly (`unpriced` calls named as such).

## 5. What it should hide, or keep behind progressive disclosure

- **Model machinery**: model names, tiers, tokens, latency, pricing versions. Only in the AI-usage page, only for owners and admins, never on a case.
- **Identifiers and internals**: UUIDs, `inputHash`, `idempotencyKey`, ledger `version` and stream sequences, `schemaVersion`, `policyVersion`, `roleMatrixVersion`. Available in a collapsed "technical details" block for support, with the `requestId` of any error.
- **Evidence machinery**: `sourceRef` and `locator` are never shown as text; they drive a highlighted span in the source document.
- **The recommendation's JSON**: rendered as the e-mail it is — recipient, subject, body — never as an `input` object.
- **The audit trail as a log**: rendered as sentences ("Marta approved the reply to Officine Rossi", "Mailbox Vendite read 3 new messages"), with `system_scope.opened` and other platform noise hidden by default.
- **Queue and intent internals**: surfaced only as three human states — "approved, sending", "sent", "sending failed, will retry".
- **Epistemic jargon**: FACT / OBSERVATION / ASSUMPTION / HYPOTHESIS become one consistent visual grammar with plain labels (§10); the codes stay in the technical block.
- **Secrets**: credentials never leave the API; an ingestion secret is displayed once with an explicit "copy it now, it will not be shown again" state and is never stored by the web app.
- **Operational readiness**: database role, migrations, provider status belong to the operator CLI, not to a business user.

## 6. Proposed information architecture

Four working areas and one settings area, each mapped to real data. Approvals are **not** a separate area: they are the head of the attention queue and a saved view of Cases, so there is one place to work and no duplicated list. [HYPOTHESIS]

| Area              | Job                                                                                                            | Backed by                                                                                     | Who                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Oggi** (home)   | "What matters right now" — decide, clarify, notice, see what went out                                          | `cases?status=awaiting_approval`, `cases?status=open`, `cases?status=resolved`, `connections` | everyone                                     |
| **Casi** (work)   | the attention list with views: Da approvare · Da chiarire · Aperti · Chiusi; filters by kind, priority, system | `cases` with `status`, `kind`, `systemKey`                                                    | everyone; decisions need the permission      |
| **Caso** (detail) | the eight levels of §11 of the brief, in one page                                                              | `cases/:id`, `documents/:id/texts`, `recommendations/:id/approve                              | reject`, `cases/:id/resolve`                 | everyone; decisions need the permission |
| **Attività**      | what happened, by whom, in sentences                                                                           | `audit`                                                                                       | owner, admin (`audit:read`)                  |
| **Impostazioni**  | Azienda · Regole · Vocabolario · Cosa può fare DOLMIR · Collegamenti · Importa dati · Costi AI                 | `workspace`, `workspace/*`, `connections`, `entities/import`, `ai-usage`                      | owner, admin; connections read for operators |

Areas that must wait for their API (§13): Clienti / Fornitori / Prodotti, Documenti, Risultati (the two promised metrics), Sistemi AI, Membri, Agente.

Extension model for future AI Systems: a case is generic; only `systemKey`, `kind`, the finding tags and the recommendation's `tool` are system-specific. The web app registers one **presenter per system** (labels for kinds and tags, a renderer per tool name — `send_mailbox_reply` renders as an e-mail) and one **generic fallback** (statement + evidence + JSON in the technical block). A second system appears by adding a presenter, not by changing screens. [HYPOTHESIS]

## 7. Proposed navigation

- **Desktop**: a left rail — Oggi · Casi (with a count of items awaiting a decision) · Attività · Impostazioni — with the organisation switcher and the signed-in user at the bottom. Page header with breadcrumb and the page's actions. No top bar of icons, no global search until there is something to search beyond one list.
- **Tablet**: the same rail collapsed to icons with labels on hover; the case detail keeps its two-column layout (case on the left, evidence drawer on the right).
- **Mobile**: three tabs — Oggi · Casi · Impostazioni (read-only). The case detail is full-screen with a sticky decision bar; the evidence drawer becomes a sheet. Settings writes are desktop and tablet only.
- **Language**: Italian-first strings with a typed string table and English as the second language; the platform's case titles, drafts and rule descriptions already come in Italian and English. [HYPOTHESIS — OD-17]
- **Organisation switch** is explicit and visible at all times; every route is `/o/<slug>/…` so a URL never implies a tenant the user did not choose, and the API's membership check remains the authority.

## 8. Proposed first screen — "Oggi"

One headline, four sections, no charts. Every section is fed by an existing endpoint, and a section that is empty disappears rather than showing a green card. [HYPOTHESIS]

1. **Headline**: the company name, the date, and one sentence computed from the data: "3 risposte aspettano la tua approvazione" — or "Niente in attesa. Ultima lettura della casella Vendite alle 10:42."
2. **Da decidere** — cases `awaiting_approval`, priority first: counterpart, kind, what DOLMIR proposes in one line ("Risposta di conferma pronta"), age, and one action: open. There is deliberately no approve button on the list: a reply is approved only after the draft has been read (§9, W1). [HYPOTHESIS — OD-19]
3. **Da chiarire** — open cases with `NON_DETERMINATO`: what is missing in the words of `missingInputs` ("Chi è il mittente: nessun cliente corrisponde a acquisti@…"), who can resolve it (you, the customer, the system).
4. **Segnali** — only when non-empty: a mailbox in error with its `lastError` in plain words, a failed send, a reply DOLMIR refused to propose because its own guard rejected it, a message containing instructions addressed to an assistant.
5. **Fatto di recente** — the last resolved cases with their outcome: "Risposta inviata a Officine Meccaniche Rossi alle 10:43 · approvata da te".

Viewers see the same page without the decision affordances; the sentence for them is the state of the inbox, not a call to act.

## 9. Core workflows

| #   | Workflow                                      | Steps as the API allows them                                                                                                                                                                                                                                                                                                                                                                | Permission                               |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| W1  | **Review and approve a proposed reply**       | open the case → read what DOLMIR understood (findings in plain words, each with its evidence one click away) → read the draft exactly as it will leave (to, subject, body, mailbox) → approve with an optional note, or reject with a note → the case shows "Approvata · invio in corso" → the page refreshes until the action exists (bounded, then stops honestly) → "Inviata alle 10:43" | `decisions:approve`                      |
| W2  | **Clarify a NON_DETERMINATO case**            | read the missing inputs → today: fix the data through CSV import (add the customer's e-mail or the product code), then close the case as resolved manually or dismissed → later: create the customer or alias inline (§12)                                                                                                                                                                  | `entities:manage` + `decisions:approve`  |
| W3  | **Set the company up**                        | profile → rules with rationale → terminology → what DOLMIR may do → connect a mailbox or issue an ingestion key (secret shown once) → import customers and products → poll once and watch the first case appear                                                                                                                                                                             | `workspace:manage`, `connections:manage` |
| W4  | **Understand what happened and what it cost** | activity in sentences, filtered by kind of event; AI usage per month with unpriced calls named                                                                                                                                                                                                                                                                                              | `audit:read`, `ai_usage:read`            |
| W5  | **Switch organisation**                       | the organisations from `/v1/me`; Dolmir's own staff will hold several memberships                                                                                                                                                                                                                                                                                                           | membership                               |

The critical-review questions of the brief (§20) apply to W1 first: can a normal business user understand what will be sent, why, and that nothing has been sent yet; can they recover (a rejection is final for that recommendation, but the case can be resolved manually and the customer answered by hand — the UI must say so).

## 10. Design system direction

Precedence: the owner's words, then the existing system in `prova_1/apps/web/app/globals.css`, then new choices. [HYPOTHESIS unless marked]

- **Inherit the site's rules**, not its mood: no component hard-codes a colour, size, radius or duration; corners are square-ish (2–6 px); **amber means uncertainty and is never decoration**; the instrument accent is used only where a measurement is reported or a primary action stands; the three faces (Archivo for display, Instrument Sans for reading, IBM Plex Mono for anything the machine produced or measured) are kept, self-hosted so builds need no network. [CONFIRMED that these are the site's rules]
- **Light by default, dark as a second skin.** The site is "a machine shop at night"; a tool used eight hours a day by the ufficio commerciale needs a daylight ground. The site's tokens already describe light as "a genuine second skin, not an inversion"; the dashboard inverts the default. [OD-16]
- **One status grammar** for the whole product, defined once and used everywhere:

  | Family         | Values → label · form                                                                                                                                                                                                                         |
  | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Case           | awaiting_approval → "Da approvare" (accent); open + NON_DETERMINATO → "Da chiarire" (amber); open → "Aperto"; resolved actioned → "Risposta inviata" (good); resolved_manually → "Chiuso"; dismissed → "Scartato" (muted)                     |
  | Recommendation | proposed → "Proposta" (outline); approved with no action → "Approvata · invio in corso" (accent, progress); executed → "Inviata" (good); rejected → "Rifiutata" (muted); failed → "Invio non riuscito" (bad)                                  |
  | Epistemic      | FACT → "Verificato" (solid mark); OBSERVATION → "Letto nel messaggio" (neutral quote mark); ASSUMPTION → "Dedotto" (amber outline); HYPOTHESIS → "Ipotesi" (amber); NON_DETERMINATO → "Non determinato" (amber block with the missing inputs) |
  | Policy level   | READ_ONLY "Solo lettura" · SUGGEST "Suggerisce" · DRAFT "Prepara bozze" · REQUIRE_APPROVAL "Chiede approvazione" · AUTO_EXECUTE "Esegue da sola" (bad-tinted, explicit)                                                                       |
  | Connection     | active "Attivo" · disabled "Disattivato" · error "Errore" (bad) with `lastError`                                                                                                                                                              |

  An uncertain conclusion can never look like a verified fact: only FACT gets the solid mark; everything amber is something DOLMIR is not sure about.

- **Components needed for Stage 4**, in order: page shell and rail; list row; status badge; button (primary, secondary, danger); decision dialog (approve / reject with note, keyboard-safe: no Enter-to-approve outside the dialog); evidence drawer with span highlighting; e-mail preview; empty, loading and error states with the request id; toast; form fields and table (settings, activity). Rendered together in a development-only `/kit` route on fixtures so they are reviewed as one system before any screen uses them.
- **Density and type**: comfortable list density, 15 px body, `tabular-nums` on every column of numbers or times, 64–72 ch reading measure in case detail.
- **Motion**: 150 ms state transitions only; no skeleton theatre, no decorative animation.
- **Accessibility**: WCAG AA contrast (the site measured its ink ladder; the light skin must be measured the same way), visible focus, everything operable by keyboard.

## 11. Technical frontend architecture

**Decision proposed: `apps/web` = Next.js 16 (App Router) + React 19 + Tailwind 4 + TypeScript strict, as workspace package `@dolmir/web`**, pinned to the site's versions (16.3.3 / 19.2.8 / 4.3.3). It matches the recorded hypothesis, the public site and the owner's stack. Alternative considered: a Vite single-page app — simpler, but it puts the token in browser storage and needs CORS on the API; rejected for security and for the server boundary below. [HYPOTHESIS — OD-15]

- **Backend-for-frontend boundary.** The browser talks only to `apps/web` on its own origin. Server components and route handlers call `apps/api` with the bearer token read from an `httpOnly`, `Secure`, `SameSite=Lax` session cookie. The API base URL and the session secret are server-only configuration, read in exactly one file (`apps/web/src/config/env.ts`, added to the ESLint allow-list), validated fail-fast like the API's loader. Nothing secret reaches the client bundle; no CORS change is needed in the API. Mutations go through server actions or same-origin route handlers with an origin check.
- **Sign-in.** Outside production, a sign-in page accepts a dev token minted by `dolmir dev-token` and stores it in the session cookie; `/v1/me` supplies `expiresAt`, so expiry is shown and handled. In production the issuer is Supabase Auth (the API already verifies its JWKS); the sign-in flow is built once hosting is decided. [UNKNOWN — OD-18]
- **Types.** `import type` from `@dolmir/core` and `@dolmir/api` only. Because JSON carries dates as strings, a mapped `Json<T>` type turns every `Date` into `string` so contracts follow Core automatically instead of being retyped. Dependency-cruiser gains two rules: `apps/web` may import Core and the API **type-only** (`dependencyTypesNot: ['type-only']` forbids anything else) and nothing imports `apps/web`.
- **Data layer.** `src/api/`: a server-only fetch client (base URL, bearer, request id pass-through, `problem+json` → a typed error with `code` and `requestId`); one module per resource. `src/data/DataSource.ts`: the interface the screens depend on, with two implementations — `ApiDataSource` and `FixtureDataSource`.
- **Mock strategy (brief §18).** Fixtures are typed with the same contracts and built from the real e2e scenario (`demo/messages/*.eml`, the Officine Rossi RFQ, a NON_DETERMINATO sender, a refused draft, a complaint). They live in `src/fixtures/`, are selected by `DOLMIR_WEB_DATA_SOURCE=fixtures`, are **refused in production by the config loader**, and are labelled on screen ("Dati di esempio"). Switching to the API is a configuration change, not a redesign.
- **Rendering.** Server components for reads, client components only for interaction (dialogs, evidence highlighting, filters); after an approval the case is re-fetched on a short bounded interval until the action record exists, then the page stops and says what it knows. No global client store, no real-time transport.
- **Quality gates, same CI.** `pnpm typecheck` gains `tsc --noEmit` for the web app (Next's tsconfig cannot be a composite project reference); ESLint gets a block for `apps/web/**` with the React and Next rules on top of the existing strict type-aware set; Prettier unchanged; dependency-cruiser includes `apps/web/src`; a `web` Vitest project (jsdom + Testing Library) for presenters and components; Playwright (Chromium is preinstalled here) for W1 on fixtures, later against the real chain with the fake provider and fake mailbox. `pnpm build` gains `next build`, which must not fetch fonts at build time.
- **Layout of the package.**

  ```
  apps/web/
    app/                    routes: (auth)/sign-in · o/[slug]/oggi · o/[slug]/casi · o/[slug]/casi/[caseId] · o/[slug]/attivita · o/[slug]/impostazioni/*
    src/config/env.ts       the only process.env reader (server-only)
    src/api/                fetch client, contracts (Json<T>), problem mapping, one module per resource
    src/data/               DataSource interface · api · fixtures
    src/fixtures/           labelled sample data from the demo scenario
    src/ui/                 tokens.css, status grammar, components (reviewed in /kit)
    src/features/           cases, decisions, workspace, activity — view models and presenters
    src/systems/            per-system presenters (commercial_inbox) + generic fallback
    src/i18n/               it.ts, en.ts
  ```

## 12. API integration strategy

**Phase A — no API change** (Stages 4–5): everything in §6–§9 is buildable on the routes of §2. The web app never re-implements a rule: it reads `permissions[]` to show or hide, and treats a 403 or a 412 from the API as the truth, rendered as a sentence with the request id.

**Phase B — small, additive API changes**, each with the e2e success and denial tests `docs/testing.md` requires: [HYPOTHESIS, ordered by value]

1. `GET /cases`: expose `before` for paging and return counts by status for the rail badge (one query).
2. `GET /orgs/:orgId/members` (`members:read`): display names for approvers and actors; the repositories exist.
3. `GET /workspace`: include current policy overrides and, per rule, rationale and version (the repository ports already return them); `GET /workspace/rules/:key/history`.
4. `GET /systems`: the registered AI Systems (key, name, version, rules) from `AiSystemRegistry.list()`.
5. `GET /entities?kind&q` and `POST /entities` / `POST /entities/:id/aliases`: the inline path for W2, replacing CSV round-trips.
6. Outcomes: the case metrics projection (time to first answer, cases per week, approved versus rejected) — the two promised customer metrics. Built when the first pilot's data exists, never before.
7. A bearer-authenticated `POST /documents` upload (an `.eml` or a file) so a user can feed a message in from the browser without holding an ingestion secret.

Not needed: CORS (the BFF is same-origin), websockets, a second backend.

## 13. What should NOT be built yet

- Customers, suppliers and products pages: no read API, and they are tables, not work. The case shows the counterpart it needs.
- Charts, KPI tiles, trends: zero clients and no metrics projection; the KPI Dashboard page in Notion says exactly why.
- The agent conversation: M9 is not built, and a chat is not the operating layer.
- Real-time updates, notifications centre, command palette, global search: nothing to push or search yet beyond one list.
- Bulk approval or approve-from-list: one draft, one decision, after reading it.
- Members management: no endpoint; provisioning stays in the CLI.
- An outcomes area before item 6 of §12 exists.
- Mobile parity for settings; per-tenant branding; a third language.
- Any business logic in the browser: priority, completeness, policy resolution and permissions stay server-side.

## 14. Risks and unknowns

| #   | Risk or unknown                                                                                                                                                                 | Marker       | Mitigation                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Production identity provider and hosting are undecided (OD-2); the sign-in flow depends on them.                                                                                | [UNKNOWN]    | Build the session boundary now with the dev issuer; add the production issuer without touching screens.                                                |
| 2   | Approval and sending are asynchronous; a UI that says "sent" on approval would lie.                                                                                             | [CONFIRMED]  | The three-state grammar of §10 and the bounded refresh of §11; "sent" only when the action record exists.                                              |
| 3   | Dates cross JSON as strings while Core types say `Date`; silent `Invalid Date` bugs are easy.                                                                                   | [CONFIRMED]  | The `Json<T>` contract layer plus one date formatter that rejects unparsable input loudly.                                                             |
| 4   | Operators cannot read audit or AI usage; the activity area is admin-only, so the case timeline must be sufficient for the people who work cases all day.                        | [CONFIRMED]  | The case detail carries its own timeline from approvals, actions and timestamps.                                                                       |
| 5   | Approvers appear as user ids until a members endpoint exists.                                                                                                                   | [CONFIRMED]  | "You" for the current user, an anonymised label for others; §12 item 2 fixes it.                                                                       |
| 6   | W2 is clumsy until entities can be created inline; a NON_DETERMINATO case needs a CSV import to resolve.                                                                        | [CONFIRMED]  | Acceptable for the first pilot; §12 item 5 is the second API addition.                                                                                 |
| 7   | The context DOLMIR actually used (which rules, which profile version) is not recorded on the case; level 5 of the detail can only show the current configuration with a caveat. | [CONFIRMED]  | Show "rules in force now"; record the applied rule versions on `analysis.completed` later (Core change, small).                                        |
| 8   | The repository's strictness (type-aware ESLint, `explicit-module-boundary-types`, `process.env` ban, dependency rules) will fight JSX and Next conventions.                     | [CONFIRMED]  | A dedicated ESLint block for `apps/web`; keep the strict rules, add React ones; one allowed `env.ts`.                                                  |
| 9   | Next.js 16 and React 19 are recent majors (Turbopack, async request APIs); Google Fonts at build time needs network the sandbox and some CI runners lack.                       | [CONFIRMED]  | Pin exact versions like the site; self-host the three OFL fonts with `next/font/local`.                                                                |
| 10  | The dashboard shows message content and personal data; the role matrix has no field-level masking, and viewers can read everything in a case.                                   | [CONFIRMED]  | Acceptable under the role matrix; noted for the owner and for `docs/privacy.md`; no PII in logs remains true because the web logs nothing of the body. |
| 11  | Integration and e2e suites cannot run in this sandbox without a PostgreSQL daemon.                                                                                              | [CONFIRMED]  | Start a local cluster from the installed binaries at Stage 5; CI already runs the service.                                                             |
| 12  | Scope: the brief lists fifteen possible areas; most have no API and no user yet.                                                                                                | [CONFIRMED]  | §13 is the guard; each stage ends with the brief's review loop answered in the pull request.                                                           |
| 13  | Italian-first copy, light default theme, approval only from the detail — reasonable defaults that are still the owner's to confirm.                                             | [HYPOTHESIS] | OD-15 … OD-19 below.                                                                                                                                   |

## 15. Recommended implementation sequence

Each stage is one reviewable increment with every gate green, ending with the brief's critical-review questions answered in the pull request description.

| Stage | Increment                                                                                                                                                                                                                                         | Exit criterion                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 3     | **Design system**: `apps/web` scaffold; tokens ported from the site with the light default; the status grammar; the Stage-4 components in a development-only `/kit` route on fixtures; all gates wired (typecheck, lint, format, depcruise, unit) | `pnpm check` green with `apps/web`; the kit reviewed by the owner against §10                 |
| 4     | **First core experience on fixtures**: sign-in with a dev token, organisation switch, Oggi, Casi with its views, case detail with the eight levels, decision dialogs, evidence drawer with span highlighting                                      | W1 walked through on the Officine Rossi fixture; review loop answered                         |
| 5     | **Real API**: `ApiDataSource`, session cookie, error mapping; run against a local API seeded with `demo:seed`; Playwright W1 against the real chain with the fake provider and fake mailbox                                                       | the `docs/demo.md` walkthrough done in the browser; "No dashboard" removed from `demo.md` §10 |
| 5b    | **Additive API endpoints** of §12 items 1–4, with e2e tests                                                                                                                                                                                       | approvers named; paging; policy and rule history visible                                      |
| 6     | **Settings** (W3): company, rules, terminology, policy, connections and ingestion keys, import, AI usage                                                                                                                                          | a company set up from the browser end to end                                                  |
| 7     | **Usability with the first pilot user**, then W2 inline entities (§12 item 5), Attività, and — only with real data — the outcomes projection (§12 item 6)                                                                                         | the two promised metrics visible to the customer                                              |

### Decisions requested from the owner (non-blocking for Stage 3, blocking for Stage 5)

| ID    | Decision              | Recommendation                                                                                             |
| ----- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| OD-15 | Stack for `apps/web`  | Next.js 16 App Router + React 19 + Tailwind 4, pinned to the site's versions, with the BFF boundary of §11 |
| OD-16 | Default theme         | Light by default for the work tool; dark as a second skin; the site's token rules kept                     |
| OD-17 | Interface language    | Italian first, English second, typed string table                                                          |
| OD-18 | Production sign-in    | Supabase Auth (the API verifies its JWKS today); decide with hosting (OD-2)                                |
| OD-19 | Approve from the list | No: a reply is approved only from the case detail, after the draft has been read                           |

**This document authorises nothing by itself.** Stage 3 starts on the owner's word.
