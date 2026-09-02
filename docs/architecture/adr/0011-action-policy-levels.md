# ADR-0011 — Action policy levels for AI tools

**Status:** Accepted · **Date:** 2026-09-02

## Context

Direction §12–§13: the AI Agent must eventually read, analyse and act through controlled tools, and company policy must decide what the AI may do — levels such as READ ONLY, SUGGEST, DRAFT, REQUIRE APPROVAL, AUTO EXECUTE. ADR-0006 already makes typed, permission-bounded tools the only way a model causes an effect. The tool framework is being built now (Phase 0 step 11); retrofitting policy onto it later would touch every tool.

## Decision

1. Every tool declares an **effect**: `read` (returns data), `analyze` (computes or classifies over provided data), `draft` (produces content that a human may later send or apply; changes nothing outside DOLMIR), `act` (changes the world or an approved record: send a message, update a record, trigger a workflow).
2. An **action policy** maps a tool invocation to a **level**: `READ_ONLY`, `SUGGEST`, `DRAFT`, `REQUIRE_APPROVAL`, `AUTO_EXECUTE`. Resolution order: tenant override for the tool → tenant override for the effect → the versioned default policy in code (`read` → READ_ONLY, `analyze` → SUGGEST, `draft` → DRAFT, `act` → REQUIRE_APPROVAL).
3. The tool executor applies the level **after** the permission check and before the handler: `READ_ONLY` and `SUGGEST` run read/analyze handlers; `DRAFT` runs draft handlers; `REQUIRE_APPROVAL` runs an `act` handler only when the call carries a reference to a persisted human approval for that exact tool and input; `AUTO_EXECUTE` runs an `act` handler without approval and is never the default. Without approval, a `REQUIRE_APPROVAL` call returns a structured `APPROVAL_REQUIRED` result (not an exception) so the agent can ask the human.
4. An **AI actor can never hold `decisions:approve`**: approval is a human act. The executor refuses human-only permissions for AI actors regardless of role.
5. Every execution, denial and approval requirement is written to the audit log with the resolved level and policy version.
6. Phase 0 ships the default policy in code, with tenant overrides as an interface backed by an in-memory adapter; the persisted override table and the approvals table arrive with the first workflow (Phase 2e).

## Why

"AI can reason and act, but company policy controls what it is allowed to do" (Direction §13) must be a property of the execution path, not of prompt wording. Declaring effects on tools makes the policy checkable in tests and visible in the audit log.

## Alternatives considered

- Permissions alone — they say _who_ may do something, not _how autonomously_; a human operator and an AI acting for that operator need different ceilings.
- Policy inside each handler — duplicated, untestable as a system property, easy to forget.
- Approval as a prompt instruction — not enforceable.

## Consequences

- Tools without an effect cannot be defined (type-level requirement).
- Approvals become first-class records; until they exist, `act` tools cannot run — which is correct for Phase 0.
- Adding a new level or per-tenant defaults is a policy change with a version bump, recorded in audit entries.
