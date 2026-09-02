# ADR-0006 — LLM boundary: provider port, typed tools, no direct data access

**Status:** Proposed · **Date:** 2026-09-02

## Context

Directive §3 (law 2), §9, §18, §19: LLMs must never mutate the database, invent business numbers, or be the source of truth for quantities, totals, dates, balances or margins; the AI system must be a set of explicit, typed, permission-bounded, auditable tools rather than one giant prompt; cost must be observable from the first call.

## Decision

1. Application code reaches models only through **`LlmProviderPort`** (`complete`, `completeStructured(schema)`), which returns `Result<LlmResponse, LlmError>` with usage and the resolved model. Requests name a **tier** (`fast | standard | deep`), never a vendor model id; tier→model mapping is configuration.
2. Exactly one real adapter in Phase 0 (**Anthropic**, official SDK, injected `fetch`) plus a scripted **`FakeLlmProvider`** for tests. Both pass the same contract suite; the Anthropic suite replays recorded exchanges without a key or network.
3. **Structured outputs** are defined as Zod schemas, converted to JSON Schema for the provider, and validated on return; invalid output is a typed `BAD_RESPONSE` error, never coerced.
4. **Typed tools** are the only way a model causes an effect: `defineTool({ name, description, input, output, permission, handler })`. The tool executor checks the caller's permission through the access module, validates input and output, records an audit entry, and returns structured results or typed errors. Handlers are deterministic code; the model never receives a database connection, a raw SQL capability, or credentials.
5. **Deterministic code owns numbers:** arithmetic, totals, quantities, date calculations, thresholds, rule evaluation, permission checks and approval policies are computed in code and passed to models as facts; models interpret, classify, extract with evidence, reason over evidence, explain and draft.
6. Every call passes through `RecordedLlmProvider`, which persists an `ai_usage` row (tenant, provider, model, tier, operation, use case, tokens, estimated cost with pricing version, latency, outcome, request/correlation ids). Prices live in a versioned, overridable `CostBook`; unpriced models record tokens with an explicit zero estimate so the gap is visible.
7. Requests carry a content hash and pass through a `CompletionCachePort` (in-memory in Phase 0) so caching is configuration later.
8. Untrusted document text is always data; system instructions never come from documents; external links in documents are never fetched automatically.

## Why

Provider independence must be a tested property (contract suite), the human gate and authorisation must be structurally unbypassable (tools with permissions), and honesty about numbers must be enforced by where they are computed, not by prompt wording.

## Alternatives considered

- Direct SDK usage in use cases — vendor lock-in, untestable without a key, no uniform cost tracking.
- An agent framework with free-form tool calling and its own state — opaque control flow, hard to audit, violates "no single giant prompt" in the other direction.
- Letting the model write through an ORM with "safe" prompts — indefensible for a system that touches commercial records.

## Consequences

- Adding a provider = one adapter + passing the contract suite.
- Adding a capability for the model = defining a tool with a schema and a permission; the audit log shows every execution.
- Numeric confidence from models is never presented as calibrated probability until a calibration record exists (see ADR-0007).
