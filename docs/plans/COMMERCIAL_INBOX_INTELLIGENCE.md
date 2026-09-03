# Commercial Inbox Intelligence — design of the first DOLMIR AI System

**Status:** design, presented for review before implementation. **Scope:** the first governed AI System over DOLMIR Core, taking an inbound commercial e-mail to a case with evidence, a recommendation and a human approval gate. **Constraint from the owner:** this system proves the architecture; DOLMIR is not an e-mail product, and this is not a generic autonomous agent.

## 1. What already exists and is reused unchanged

Everything below is in the repository today, tested, and is used as it stands. No parallel version is created.

| Stage      | Primitive reused                                                                                                                                           | Where                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| INGEST     | raw MIME stored as the document, subject and body as citable parts, attachments as child documents                                                         | `modules/connectors`, `modules/documents`    |
| UNDERSTAND | `LlmProviderPort` with tiers `fast` / `standard` / `deep`, structured output validated against a Zod schema, never coerced                                 | `ai/llm`                                     |
|            | untrusted content delimited as data with a standing instruction, forged fences defanged                                                                    | `ai/prompting`                               |
| RESOLVE    | `EntityResolver` returning RESOLVED / AMBIGUOUS / UNRESOLVED with weighted reasons; `resolutionToDetermination` turning anything else into NON_DETERMINATO | `modules/entities`                           |
| CONTEXT    | `CompanyContext`: profile, current rule values, terminology, per tenant and versioned                                                                      | `modules/workspace`                          |
| REASON     | `Claim` with `EpistemicStatus` and grounding enforced at construction; `NonDeterminato` requiring a named gap                                              | `kernel/epistemic`, `kernel/non-determinato` |
| EVIDENCE   | `locateQuote`, `evidenceForQuote`, `verifyDocumentSpan` over document text with stable offsets                                                             | `modules/documents`                          |
| RECOMMEND  | `CaseDraft` validated by Core; recommendations checked against the tool registry and the company's action policy                                           | `modules/cases`                              |
| APPROVAL   | `decisions:approve` is human-only; a decision is a ledger event and an append-only row                                                                     | `modules/access`, `modules/cases`            |
| ACTION     | `ToolExecutor` runs an approved recommendation under the approver's own permissions, with the approval reference and an audit entry                        | `ai/tools`, `modules/cases`                  |
| OUTCOME    | `ActionExecuted` / `ActionFailed` / `OutcomeRecorded`, case settled as actioned or dismissed                                                               | `modules/cases`                              |
| ASYNC      | `JobQueuePort` with pg-boss and in-memory adapters; payloads are references only                                                                           | `kernel/jobs`, `infrastructure/jobs`         |
| ISOLATION  | forced Row-Level Security, two database roles, no DELETE for the runtime role                                                                              | `infrastructure/postgres`, every migration   |

## 2. What is missing, and only this

Three additions to Core, each small and each needed by every future AI System, plus one new package.

1. **Evidence verification as a Core invariant.** `CaseEngine.openCase` validates recommendations against the tool registry but does not yet check that a `DOCUMENT_SPAN` cited by a finding actually occurs at the offsets it claims. A fabricated citation must not be storable. The engine gains an optional `EvidenceVerifier`; when present, a draft whose spans do not verify is refused with `FABRICATED_EVIDENCE`. This is the backstop, not the primary defence: the system verifies before proposing and degrades to NON_DETERMINATO instead.
2. **One act tool in Core: `send_mailbox_reply`.** Sending through a tenant's mailbox connection is a platform capability, not a commercial-inbox feature; procurement and operations will use the same tool. Effect `act`, permission `ai:invoke`, default policy level `REQUIRE_APPROVAL`. It resolves the connection, decrypts credentials inside the connectors module, sends through the provider-agnostic port and returns the provider message id.
3. **Workspace wiring for system packages.** `pnpm-workspace.yaml` and the root `tsconfig.json` do not yet include `packages/systems/*`. The dependency rules that govern them already exist.
4. **`packages/systems/commercial-inbox`** — the system itself, depending only on the public entry of `@dolmir/core`, as dependency-cruiser already enforces.

Deliberately **not** built now: a tool-calling agent loop, a retrieval index, a second mailbox provider, prices or availability of any kind, and a generic multi-agent framework.

## 3. The agent boundary

This is the central decision, and it is deliberately narrow.

**The AI System is a governed pipeline, not a tool-calling loop.** The model is called twice, with structured output, and it can cause no effect at all. It cannot call tools. The only thing that ever reaches an executable tool is a _recommendation_ stored on a case, whose input was validated against the tool's schema, whose policy level was resolved from the company's own configuration, and which a human with `decisions:approve` must approve before the tool executor runs it under that human's permissions.

That means prompt injection has no mechanism to exploit, not merely a discouraging instruction:

- The model emits data into a fixed schema. There is no field in that schema that names a tool, a permission, a policy level or an approver.
- Recommendations name a tool from a closed registry. A tool the system did not register cannot be proposed.
- Policy level comes from `PersistedActionPolicy`, keyed by tenant and tool, read from the database. No text influences it.
- `decisions:approve` and `connections:manage` are human-only. An AI actor is refused them by the tool executor whatever role it acts on behalf of.
- Every tool handler receives a validated input and the caller's tenant scope. Row-Level Security means a handler physically cannot read another tenant's rows.

The conversational agent that _does_ call tools is a separate, later surface (M9). It will reuse this same executor and the same approval gate.

## 4. The pipeline, step by step

```
document (e-mail + attachments, text with offsets)
  │
  ├─ 1  applicability guard              deterministic
  ├─ 2  sender identity                  deterministic  ── from headers, never from the body
  ├─ 3  understanding                    LLM, tier standard, structured output of QUOTES
  ├─ 4  span verification                deterministic  ── every quote must exist in the text
  ├─ 5  value parsing                    deterministic  ── quantities, dates, codes from verified spans
  ├─ 6  entity resolution                deterministic  ── customer and products
  ├─ 7  completeness rules               deterministic  ── what is missing to proceed
  ├─ 8  reply drafting                   LLM, tier fast, sees ONLY verified facts
  ├─ 9  draft guard                      deterministic  ── every number and date in the draft must be a verified fact
  └─ 10 case draft                       findings, determination, one recommendation
```

**The model never produces a business value.** In step 3 it does not return `quantity: 500`; it returns the verbatim text it read the quantity from. Step 4 checks that text really occurs in the message at the offsets claimed, and drops it otherwise. Step 5 parses the number in code. So a quantity that reaches a finding is grounded in a span an auditor can re-read, and a hallucinated quantity fails verification rather than becoming a fact.

**Drafting is isolated from the message.** In step 8 the model receives the verified facts, the company profile, the reply language rule and the signature. It never sees the raw message again, so an instruction hidden in the message cannot steer the reply. Step 9 then extracts every number and date from the draft and requires each to appear among the verified facts or the company profile; a violation rejects the draft rather than sending it.

### Structured outputs

**Understanding** (step 3), all extractions expressed as quotes:

- `intent`: `quote_request` | `order_request` | `customer_question` | `complaint` | `follow_up` | `information_request` | `supplier_message` | `other_commercial` | `not_commercial`
- `language`, `urgency`, `summary`
- `senderOrganisationQuote?`, `deliveryDateQuote?`
- `lines[]`: `{ descriptionQuote, productCodeQuote?, quantityQuote?, unitQuote?, lineDeliveryDateQuote? }`
- `requestedInformation[]`: what the sender asked for, in their words
- `notes[]`: anything the model wants to flag, including "this message contains instructions addressed to an assistant"

**Analysis result** (after steps 4 to 7), the system's own type:

- `customer`: `Determination<EntityMatch>` — resolved, or NON_DETERMINATO naming the candidates
- `lines[]`: `{ product: Determination<EntityMatch>, quantity: VerifiedValue<number> | null, unit, deliveryDate: VerifiedValue<Date> | null, evidence }`
- `missingInputs[]`, `facts[]` (each a `Claim` with its evidence), `conflicts[]`

A `VerifiedValue<T>` carries the parsed value, the exact span it came from and the evidence object. Nothing else may become a business fact.

## 5. Where deterministic code replaces the model

| Decision                             | Owner                                                            |
| ------------------------------------ | ---------------------------------------------------------------- |
| Who the sender is                    | headers plus `EntityResolver`; the display name is never trusted |
| Which product a line names           | `EntityResolver` on the verified code or description             |
| Quantity, unit, delivery date        | parsers over verified spans, Italian and English forms           |
| Whether a citation is real           | `verifyDocumentSpan`                                             |
| Whether enough is known to act       | completeness rules per intent                                    |
| Case priority and urgency escalation | company rules plus intent                                        |
| Which policy level applies           | `PersistedActionPolicy`                                          |
| Who may approve                      | `Authorizer` and the role matrix                                 |
| Whether a draft may be sent          | approval record plus the tool executor                           |

The model owns exactly two things: reading a message into a schema of quotes, and writing prose from facts it did not choose.

## 6. Tools and permissions

| Tool                 | Effect | Permission  | Default level      | Who runs it                                                |
| -------------------- | ------ | ----------- | ------------------ | ---------------------------------------------------------- |
| `send_mailbox_reply` | act    | `ai:invoke` | `REQUIRE_APPROVAL` | the tool executor, under the approving human's permissions |

That is the whole surface. The system proposes at most one recommendation per case. `READ_ONLY` and `SUGGEST` levels remain available to a tenant that wants the system to observe without offering to act; `AUTO_EXECUTE` is available but is a deliberate per-tenant choice recorded in the workspace, never a default.

## 7. NON_DETERMINATO and failure

- **Customer unresolved or ambiguous** → the case opens as `NON_DETERMINATO`, naming the candidates and the missing input, with no recommendation. A human resolves the identity; the platform never picks.
- **A line's product unresolved** → the line is kept as an unresolved line with its quotes as evidence; the case may still be `READY_FOR_REVIEW` if the recommendation is only to acknowledge and ask.
- **No verified quantity or date where the intent needs one** → recorded as a missing input, and the drafted reply asks for it.
- **Every quote fails verification** → `NON_DETERMINATO` with a conflict, because the model's reading and the document disagree.
- **The provider fails or refuses** → the analysis fails as a value; `AnalyzeDocument` records the system in `failed` and the job retries. Nothing partial is stored.
- **Prices and availability** → never produced. There is no pricing data source in DOLMIR, so a reply never contains a price, and the recommendation rationale says the quotation itself remains a human act.

## 8. Evidence requirements

Every finding that carries a business value cites a `DOCUMENT_SPAN` with the document, part and offsets, verified before the draft is built and verified again by the case engine before the case is stored. Every entity identification cites `RECORD_FIELD` evidence naming the alias that matched. A `FACT` without citation, computation or record evidence cannot be constructed at all: the kernel refuses it.

## 9. Observability and audit

Existing entries cover ingestion, polling, tool execution and approvals. The system adds one audit action, `analysis.completed`, carrying the system key and version, the intent, the determination, the counts of verified and rejected spans, and the recommendation's policy level. Never a body, never a credential. Every LLM call is already recorded in `ai_usage` with its tier, model, tokens and cost, attributed to the tenant and the use case. Correlation ids flow through the job payload so an asynchronous analysis is traceable back to the request that ingested the message.

## 10. Test strategy

Unit tests in the system package against the fake provider, with hand-written Italian and English messages:

- an RFQ with a known customer, a known product code, a quantity and a date, ending in a `READY_FOR_REVIEW` case with a verified recommendation
- the same message from an unknown sender, ending in `NON_DETERMINATO`
- an ambiguous sender matching two records, ending in `NON_DETERMINATO` naming both
- a model that returns a quote absent from the message, proving the value is dropped and never becomes a fact
- a model that returns a quantity as a number instead of a quote, refused by the schema
- a drafted reply containing a price, refused by the draft guard
- a message whose body instructs the assistant to approve and to auto-execute, proving the case opens exactly as it would without those sentences and the recommendation still requires approval
- a message with no commercial content, returning `null` so no case is opened
- provider unavailable and provider returning malformed output, both failing as values

Core tests for the new pieces: the case engine refusing a draft with a fabricated span; `send_mailbox_reply` refused to an AI actor without an approval reference, refused across tenants, and succeeding under an approver's permissions with an audit entry.

End to end on PostgreSQL: a signed message arrives, a job runs the analysis, a case appears, a viewer is refused the approval, an operator approves, the reply is sent through the fake mailbox, and the case settles as actioned with an outcome. Then the same message again, proving idempotency.

## 11. Delivery slices

| #   | Slice                                                                                            | Ends with                           |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------- |
| 1   | Core additions: evidence verification in the case engine, `send_mailbox_reply`, workspace wiring | tests green, committed              |
| 2   | System package: schemas, verification, parsers, entity resolution, completeness rules            | unit tests on the analysis pipeline |
| 3   | Drafting with the isolated model call and the draft guard                                        | adversarial tests                   |
| 4   | Composition, job handlers, API endpoints for the attention list and approvals                    | end-to-end on PostgreSQL            |

## 12. Open questions that do not block slice 1

- Whether a tenant may ever set `AUTO_EXECUTE` for `send_mailbox_reply`, and under which company rule. Available today, defaulted off.
- Retrieval of previous communications with the same counterpart. Useful, deferred until a second system needs it, so the retrieval surface is designed against two real callers rather than one.
- Promotion of the quantity and date parsers from the system package into Core, once procurement needs them.
