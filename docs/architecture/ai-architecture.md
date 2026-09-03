# AI architecture

Implements ADR-0006 (LLM boundary), ADR-0007 (epistemics), ADR-0011 (action policy). Code: `packages/core/src/ai`.

## Principles, as code

| Principle                                            | Where it is enforced                                                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Models never touch the database                      | Handlers receive validated input and a `TenantScope`; the model receives tool _results_. No tool exposes SQL or a connection.                                                    |
| Models never invent numbers                          | Structured outputs are Zod-validated; numbers that matter are computed in deterministic code and passed to models as facts; `FACT` claims are unconstructible without grounding. |
| Effects only through typed, permission-bounded tools | `ToolExecutor`: permission (access module) → human-only check → input validation → action policy → handler → output validation → audit, every time.                              |
| Approval is a human act                              | `HUMAN_ONLY_PERMISSIONS` (`decisions:approve`) is refused to AI actors regardless of role; `act` tools need a matching approval under the default policy.                        |
| Honesty over coverage                                | `declare_non_determinato` is the model's only way to say "cannot be determined", and the kernel rejects vague declarations.                                                      |
| Cost is observable from the first call               | `RecordedLlmProvider` writes one `ai_usage` row per call — success, failure or cache hit — priced by a versioned `CostBook`.                                                     |
| Untrusted text is data                               | `LlmRequest.system` carries DOLMIR's instructions; everything from outside goes into `messages`; nothing there is ever an instruction to the platform.                           |

## The provider port

```ts
interface LlmProviderPort {
  readonly name: string; // 'anthropic' | 'fake' | 'none'
  readonly capabilities: { structuredOutput: boolean; vision: boolean };
  complete(request: LlmRequest): Promise<Result<LlmResponse, LlmError>>;
  completeStructured<T>(
    request: LlmRequest,
    schema: z.ZodType<T>,
  ): Promise<Result<StructuredLlmResponse<T>, LlmError>>;
}
```

- Requests name a **tier** (`fast` | `standard` | `deep`), an **operation** and a **use case**; the tier → model table comes from configuration (`DOLMIR_AI_MODEL_*`) with conservative defaults (Haiku 4.5 / Sonnet 5 / Opus 5).
- Responses carry the resolved model, usage (input, output, cache read, cache write), stop reason, latency, provider request id and `cached`.
- Failures are `LlmError` values with a `kind` (`PROVIDER_NOT_CONFIGURED`, `INVALID_REQUEST`, `AUTHENTICATION`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `BAD_RESPONSE`, `REFUSED`, `TRUNCATED`, `UNKNOWN`), a category, `retryable`, and an `attempt` with the tokens a failed call consumed.

Adapters: `AnthropicLlmProvider` (the only place `@anthropic-ai/sdk` may appear; injected `fetch`; structured output via `output_config.format` from the Zod schema; validation done locally; no sampling parameters), `FakeLlmProvider` (scripted, never invents, fails unscripted requests), `UnconfiguredLlmProvider` (`DOLMIR_AI_PROVIDER=none`). Decorators: `RecordedLlmProvider` (usage), `CachingLlmProvider` over `CompletionCachePort` (in-memory adapter; the tenant is part of the key; not wired by default).

The contract suite (`tests/contract/llm-provider.contract.ts`) runs the same behaviours against the fake and against the Anthropic adapter over replayed exchanges. **The Anthropic cassettes are synthesised from the SDK's response schema** — each file says so — because no API key was available while building; setting `DOLMIR_TEST_ANTHROPIC_API_KEY` re-records the success scenarios from the live API. Error scenarios stay synthesised (they cannot be induced on demand).

## Typed tools

```ts
defineTool({
  name: 'lookup_customer',        // snake_case, unique in the registry
  description: '...',             // written for the model: what and when
  effect: 'read',                 // read | analyze | draft | act
  permission: Permission.AI_INVOKE,
  input: z.object({ code: z.string() }),
  output: z.object({ name: z.string() }),
  handler: async (input, context) => ok({ name: ... }),   // deterministic code; context = tenant, actor, scope
});
```

`ToolRegistry.describe()` renders provider-agnostic descriptors (name, description, effect, permission, JSON Schema) for the agent loop of Phase 2. `ToolExecutor.execute(context, call)` returns a structured result the loop can act on: `ok`, `error` (validation, permission, domain failure), `approval_required` (with the input digest a human must approve), `not_permitted` (policy level too low). Infrastructure and internal failures are rethrown after being audited.

### Action policy (ADR-0011)

| Effect    | Default level      | Meaning                                                                                         |
| --------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `read`    | `READ_ONLY`        | runs                                                                                            |
| `analyze` | `SUGGEST`          | runs; the result is a suggestion                                                                |
| `draft`   | `DRAFT`            | runs; produces content a human may later send or apply                                          |
| `act`     | `REQUIRE_APPROVAL` | runs only with an approval matching tool name and input digest; `AUTO_EXECUTE` never by default |

Resolution order: tenant override per tool → tenant override per effect → default (`InMemoryActionPolicy` today; a configuration table in Phase 2). Every execution records level, policy version, input digest and outcome in the audit log.

Built-in tools: `declare_non_determinato` (analyze) and `request_human_decision` (draft; yields a pending `HUMAN_DECISION_REQUESTED` value that the approvals store of Phase 2 will persist).

## Cost book

`DEFAULT_COST_BOOK` version 1 prices `claude-opus-5` ($5 / $25 per million input / output tokens) and `claude-sonnet-5` ($2 / $10), cache reads at 0.1× and writes at 1.25× of input, as documented in the Claude API skill bundled with the toolchain (model-migration notes, 2026). `claude-haiku-4-5` is deliberately unpriced until confirmed against the pricing page: its calls record tokens with `estimated_cost = 0` and `priced = false`, and the usage summary counts them as `unpricedCalls`. Review prices before the first paid deployment and bump the version.

## What comes next (Phase 2)

The agent loop (conversation state, planning, tool calls with the vendor SDK's tool runner inside the adapter), persisted approvals, per-tenant policy overrides, document ingestion with evidence spans, entity resolution, company memory as structured tables plus a retrieval index behind a port, and evals on real, permitted documents. None of it changes the contracts above.
