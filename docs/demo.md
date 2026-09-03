# Running the DOLMIR demo

Everything below has been executed against a fresh PostgreSQL 16 on the branch it documents. Where something is not exercised end to end, it says so.

## 1. What must be running

| Requirement                  | Why                                                                   | Note                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| PostgreSQL 16 or later       | every table, the ledger, the audit trail and the job queue live there | one database is enough                                                                                  |
| Node 22.12 or later, pnpm 10 | the runtime and the workspace                                         | `corepack enable` picks up the pinned pnpm                                                              |
| An Anthropic API key         | the two model calls: reading a message and drafting a reply           | without it ingestion, cases and approvals still work; analysis fails with `LLM_PROVIDER_NOT_CONFIGURED` |

Nothing else. No Redis, no queue service, no mail server: the demo uses the in-memory mailbox, which accepts a reply and keeps it so you can read it.

## 2. Environment

Create `.env` at the repository root. A command run from anywhere in the workspace finds it.

```bash
cat > .env <<'EOF'
DOLMIR_ENV=development
DOLMIR_DATABASE_URL=postgres://dolmir_app:dolmir_app_test@127.0.0.1:5432/dolmir_demo
DOLMIR_DATABASE_OWNER_URL=postgres://dolmir_owner:dolmir_owner_test@127.0.0.1:5432/dolmir_demo
DOLMIR_AUTH_ISSUER=http://localhost:3000/dev-auth
DOLMIR_AUTH_AUDIENCE=dolmir
DOLMIR_AUTH_HS256_SECRET=dev-only-secret-change-me-please-32chars
DOLMIR_MAILBOX_DRIVER=fake
DOLMIR_JOBS_DRIVER=memory
DOLMIR_STORAGE_DRIVER=memory
DOLMIR_AI_PROVIDER=anthropic
DOLMIR_AI_ANTHROPIC_API_KEY=sk-ant-...
EOF
echo "DOLMIR_SECRETS_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" >> .env
```

`DOLMIR_SECRETS_KEY` encrypts every connector credential. Losing it makes existing connections unreadable; changing it is a re-encryption task that does not exist yet. `.env` is git-ignored.

Every variable is validated at boot. An unknown `DOLMIR_*` name is a boot failure that lists the recognised ones, so a typo never becomes a silent default.

## 3. Database and schema

```bash
psql -h 127.0.0.1 -U postgres -c "CREATE ROLE dolmir_owner LOGIN PASSWORD 'dolmir_owner_test' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS"
psql -h 127.0.0.1 -U postgres -c "CREATE ROLE dolmir_app   LOGIN PASSWORD 'dolmir_app_test'   NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS"
psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE dolmir_demo OWNER dolmir_owner"

pnpm install
pnpm --filter @dolmir/api cli migrate
pnpm --filter @dolmir/api cli doctor
```

`doctor` prints the configuration, the database role, whether that role can bypass row-level security (it must not), the migration state and the AI provider.

## 4. Set a company up

```bash
pnpm --filter @dolmir/api cli demo:seed --slug alfa --owner-subject "auth|you"
```

It provisions the organisation and its owner, imports three customers, one supplier and five products, writes the company profile, sets the reply language, the response SLA and the quotation lead time, records three terms of the company's own vocabulary, creates a mailbox connection and issues an ingestion key.

It prints the organisation id, the owner user id, the mailbox connection id and the ingestion key with its secret. **The secret is shown once**; the platform keeps only its encrypted copy. Keep the whole output.

## 5. Feed a message in

Seven realistic messages are in `demo/messages/`. Two ways to deliver one.

**From the command line**, ingesting and analysing in the foreground so you see the result immediately:

```bash
pnpm --filter @dolmir/api cli demo:send --org <ORG_ID> --file ../../demo/messages/01-rfq-cliente-noto.eml
```

**Over HTTP**, the way a forwarding rule or an automation node would, with an HMAC signature:

```bash
ORG=<ORG_ID>; KEY=<keyId>; SECRET=<secret>; FILE=demo/messages/01-rfq-cliente-noto.eml
TS=$(date +%s); NONCE="n-$(openssl rand -hex 8)"
SIG=$(node -e "
const fs=require('fs'),c=require('crypto');
const body=fs.readFileSync(process.argv[1]);
const s=['v1',process.argv[2],process.argv[3],process.argv[4],c.createHash('sha256').update(body).digest('hex')].join('\n');
console.log(c.createHmac('sha256',Buffer.from(process.argv[5],'base64')).update(s).digest('hex'));
" "$FILE" "$KEY" "$TS" "$NONCE" "$SECRET")

curl -i -X POST "http://127.0.0.1:3000/v1/orgs/$ORG/ingest/messages" \
  -H "content-type: message/rfc822" \
  -H "x-dolmir-key-id: $KEY" -H "x-dolmir-timestamp: $TS" \
  -H "x-dolmir-nonce: $NONCE" -H "x-dolmir-signature: $SIG" \
  --data-binary "@$FILE"
```

`202` means accepted and queued for analysis; `200` with `duplicate: true` means the message was already ingested; `401` means the signature, the key or the nonce did not hold up. Replaying the same nonce is refused.

Your own messages work the same way: save any `.eml` and point at it. Attachments in `text/plain`, `text/html`, `text/csv` and `text/markdown` are read; a PDF is stored and recorded as `unsupported` rather than silently skipped.

## 6. Look at what DOLMIR made of it

```bash
pnpm --filter @dolmir/api dev              # the API on http://127.0.0.1:3000
pnpm --filter @dolmir/api cli dev-token --subject "auth|you"
```

```bash
TOKEN=<the token>; ORG=<ORG_ID>
curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:3000/v1/orgs/$ORG/cases" | jq
curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:3000/v1/orgs/$ORG/cases/<CASE_ID>" | jq
```

The case detail carries the findings with their evidence, the recommendation with its policy level, the approvals and the actions. Every span cites a document and offsets you can re-read:

```bash
curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:3000/v1/orgs/$ORG/documents/<DOCUMENT_ID>/texts" | jq
```

Or from the command line: `cli demo:cases --org <ORG_ID>` and `cli demo:case --org <ORG_ID> --case <CASE_ID>`.

## 7. Approve, and watch the reply leave

```bash
curl -s -X POST -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"note":"Va bene, conferma la ricezione."}' \
  "http://127.0.0.1:3000/v1/orgs/$ORG/recommendations/<RECOMMENDATION_ID>/approve" | jq
```

The response carries the approval and the action. The case settles as `resolved` with resolution `actioned`. With `DOLMIR_MAILBOX_DRIVER=fake` the message is accepted by the in-memory mailbox rather than sent; `cli demo:approve` prints what that mailbox received. `/reject` records the rejection and dismisses the case.

An approval by a viewer is refused with `PERMISSION_DENIED`. No AI actor can hold `decisions:approve` at all.

## 8. The API surface

| Method and path                                    | Permission                    | What it does                                            |
| -------------------------------------------------- | ----------------------------- | ------------------------------------------------------- |
| `POST /v1/orgs/:orgId/ingest/messages`             | HMAC signature                | deliver a raw MIME message                              |
| `GET /v1/orgs/:orgId/cases`                        | `organization:read`           | the attention list                                      |
| `GET /v1/orgs/:orgId/cases/:caseId`                | `organization:read`           | findings, evidence, recommendations, approvals, actions |
| `POST /v1/orgs/:orgId/cases/:caseId/resolve`       | `decisions:approve`           | close a case by hand                                    |
| `POST /v1/orgs/:orgId/recommendations/:id/approve` | `decisions:approve`           | approve and execute                                     |
| `POST /v1/orgs/:orgId/recommendations/:id/reject`  | `decisions:approve`           | reject                                                  |
| `GET /v1/orgs/:orgId/documents/:id/texts`          | `organization:read`           | the text a citation points at                           |
| `GET /v1/orgs/:orgId/workspace`                    | `organization:read`           | profile, rules, terminology, known rule keys            |
| `PATCH /v1/orgs/:orgId/workspace/profile`          | `workspace:manage`            | change the company profile                              |
| `PUT /v1/orgs/:orgId/workspace/rules/:key`         | `workspace:manage`            | set a rule, versioned                                   |
| `POST /v1/orgs/:orgId/workspace/terminology`       | `workspace:manage`            | teach a company word                                    |
| `PUT /v1/orgs/:orgId/workspace/policy`             | `workspace:manage`            | raise or lower a tool's policy level                    |
| `POST /v1/orgs/:orgId/entities/import`             | `entities:manage`             | import customers, suppliers and products from CSV       |
| `GET`/`POST /v1/orgs/:orgId/connections`           | `connections:read` / `manage` | list and create connections                             |
| `POST /v1/orgs/:orgId/connections/ingestion-keys`  | `connections:manage`          | issue a signing key, shown once                         |
| `POST /v1/orgs/:orgId/connections/:id/poll`        | `connections:manage`          | poll a mailbox now                                      |
| `GET /v1/orgs/:orgId/audit`                        | `audit:read`                  | the audit trail                                         |
| `GET /v1/orgs/:orgId/ai-usage`                     | `ai_usage:read`               | model calls, tokens and cost                            |

There is no dashboard yet. The API and the CLI are the whole surface.

## 9. Real versus deterministic

| Part                                                            | Real                                       | Deterministic or local                                                 |
| --------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| PostgreSQL, row-level security, ledger, audit                   | real                                       |                                                                        |
| MIME parsing, text extraction, evidence spans                   | real                                       |                                                                        |
| Entity resolution, parsers, completeness rules, the draft guard | real, no model involved                    |                                                                        |
| The two model calls                                             | real, against Anthropic, when a key is set | scripted in every test                                                 |
| Sending a reply                                                 |                                            | in-memory mailbox by default                                           |
| IMAP and SMTP                                                   | code is real and typed                     | exercised against a fake client only; never run against a live mailbox |
| Background jobs                                                 | pg-boss adapter written                    | the demo uses the in-memory queue                                      |

## 10. Known limitations

- **No live mailbox has ever been used.** The IMAP and SMTP adapter compiles, is bounded by timeouts and is unit-tested against a fake client. Connecting a real account is a deployment task and it may reveal problems this suite cannot.
- **No dashboard.** Reading a case means reading JSON.
- **pg-boss is not exercised end to end.** `dolmir jobs:migrate` does not exist yet, so `DOLMIR_JOBS_DRIVER=pg-boss` is untested; the in-memory queue runs handlers in the same process and loses them on restart.
- **No retention, deletion or export.** See `privacy.md`; erasure against an immutable ledger is an open decision.
- **The Anthropic contract tests replay synthesised exchanges**, not recordings of real calls, because no key was available when they were written.
- **Only Italian and English** are handled well by the date parser and the drafting instructions.
- **One attachment format family.** PDF and office documents are stored and marked `unsupported`; nothing reads them yet.
- **The reply is never a quotation.** DOLMIR holds no pricing data, so a draft that mentions a price or a currency is refused by the guard.
