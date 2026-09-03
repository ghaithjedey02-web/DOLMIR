# Data model

Source of truth: `supabase/migrations/*.sql`, applied by the platform's own migrator (checksummed, forward-only, advisory-locked). This document explains the tables; it never contradicts them.

## Conventions

- Every tenant table carries `organization_id` and has Row-Level Security **enabled and forced**. Policies use `dolmir.tenant_access(organization_id)`, which is true in the row's tenant scope or in system scope.
- Scopes are transaction-local settings: `dolmir.tenant_id` and `dolmir.scope` (`tenant` | `system`), set by the transaction runner only. A transaction without a scope sees nothing.
- Two roles: `dolmir_owner` owns objects and runs migrations; `dolmir_app` is the runtime role (`NOBYPASSRLS`, no `DELETE` anywhere, no `UPDATE` on append-only tables).
- Append-only tables carry the `dolmir.forbid_mutation()` trigger, which raises SQLSTATE `23000` for every role, owner included.
- Time is `timestamptz`; identifiers are `uuid`; evolving records carry `schema_version`.

## Tables (migrations 000100–000500)

| Table                    | Purpose                                                                                                                                                              | Tenant-scoped                                          | Append-only |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------- |
| `schema_migrations`      | migration ledger: version, name, checksum, applied_at, applied_by                                                                                                    | no (allow-listed)                                      | by practice |
| `organizations`          | tenants: id, slug (citext, unique), name, status (`active` / `suspended`)                                                                                            | yes (RLS by own id)                                    | no          |
| `users`                  | global identities: auth_subject (provider subject), email, display_name                                                                                              | visibility through membership; written in system scope | no          |
| `memberships`            | (organization_id, user_id) → role_key (`owner` / `admin` / `operator` / `viewer`), status                                                                            | yes                                                    | no          |
| `audit_log`              | who did what: actor {type,id,on_behalf_of}, action `resource.verb`, target, outcome, request/correlation ids, details                                                | yes; platform rows (`NULL` tenant) in system scope     | **yes**     |
| `ledger_events`          | business facts with provenance: stream (type, id, sequence), global_sequence, event_type, schema_version, payload, provenance, idempotency_key                       | yes                                                    | **yes**     |
| `projection_checkpoints` | how far each projection consumed the ledger                                                                                                                          | no (allow-listed)                                      | no          |
| `ai_usage`               | one row per model call: provider, model, tier, operation, use_case, tokens (input/output/cache), estimated_cost + pricing_version + priced, latency, outcome, cached | yes; platform rows in system scope                     | **yes**     |

The SQL invariants test fails CI if a new table appears without forced RLS and a policy (unless allow-listed in the test), if `dolmir_app` gains `DELETE` anywhere or `UPDATE` on an append-only table, or if an append-only table lacks the trigger.

## Ledger semantics

- A stream is one thing (`document/<id>`, `case/<id>`): `UNIQUE (organization_id, stream_type, stream_id, stream_sequence)` makes optimistic concurrency a constraint, and `pg_advisory_xact_lock` serialises appenders per stream.
- `idempotency_key` is unique per tenant: replaying the same append returns the original event.
- `provenance` is mandatory (`sourceKind`, `sourceRef`, `actor`, `recordedBy`, evidence refs); the CHECK constraint refuses a fact without it.
- Projections read the global sequence in order and record their checkpoint; `rebuild` resets and replays.

## Cost queries the `ai_usage` table answers

```sql
-- per tenant, per use case and model (what /v1/orgs/:orgId/ai-usage returns)
SELECT use_case, model, count(*) AS calls, sum(input_tokens) AS input_tokens,
       sum(output_tokens) AS output_tokens, sum(estimated_cost) AS estimated_cost,
       count(*) FILTER (WHERE NOT priced) AS unpriced_calls
  FROM public.ai_usage
 WHERE organization_id = dolmir.current_tenant()
 GROUP BY use_case, model;
```

`unpriced_calls > 0` means the cost book lacks a price for a model in use: the tokens are real, the zero estimate is not a saving. An EUR reporting rate, when needed, is a documented constant reviewed periodically, never a live lookup.

## Reserved (designed, not created)

`documents`, `document_versions`, `extractions`, `entities` / `entity_aliases`, `cases`, `findings`, `evidence`, `decisions`, `approvals`, `company_profile`, `company_rules`, `terminology`, `tenant_connections`, `tenant_policy_overrides`, `outcomes`. They arrive with the first AI System (Commercial Inbox Intelligence). Material-intelligence tables (`material_events` with the documented → ordered → receipt_claimed → receipt_confirmed → available → … vocabulary) belong to a later module.
