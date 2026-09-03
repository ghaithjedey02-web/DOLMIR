import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

import type { Secret } from '../../../infrastructure/config/secret.js';
import { type Clock, systemClock } from '../../../kernel/clock.js';
import { safeSnippet } from '../../../kernel/redaction.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import {
  DEFAULT_MAX_TOKENS,
  type ModelRouting,
  createModelRouting,
} from '../../llm/model-routing.js';
import {
  type LlmAttempt,
  LlmError,
  type LlmProviderPort,
  type LlmRequest,
  type LlmResponse,
  type LlmStopReason,
  type StructuredLlmResponse,
  ZERO_USAGE,
  checkLlmRequest,
} from '../../llm/port.js';

/**
 * The one real adapter of Phase 0 (ADR-0006 section 2), on the official SDK.
 *
 * - The API key is a `Secret`, revealed only into the SDK client.
 * - `fetch` is injectable: the contract suite replays recorded exchanges with
 *   no key and no network, and a recording run captures real ones.
 * - Structured output uses the Messages API `output_config.format` built from
 *   the caller's Zod schema by the SDK helper; the text is parsed and
 *   validated here, so an invalid answer becomes a typed BAD_RESPONSE that
 *   still carries the tokens it cost.
 * - No sampling parameters are sent: current models reject `temperature`.
 */
export type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AnthropicLlmProviderOptions {
  readonly apiKey: Secret;
  readonly baseUrl?: string;
  readonly routing?: ModelRouting;
  readonly fetch?: HttpFetch;
  /** SDK retries on 429 / 5xx / connection errors. Default 2; contract tests use 0. */
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  readonly clock?: Clock;
}

export const ANTHROPIC_PROVIDER_NAME = 'anthropic';
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

type OutputFormat = NonNullable<Anthropic.OutputConfig['format']>;

interface Exchange {
  readonly message: Anthropic.Message;
  readonly latencyMs: number;
  readonly requestId: string | undefined;
}

export class AnthropicLlmProvider implements LlmProviderPort {
  readonly name = ANTHROPIC_PROVIDER_NAME;
  readonly capabilities = { structuredOutput: true, vision: false } as const;
  private readonly client: Anthropic;
  private readonly routing: ModelRouting;
  private readonly clock: Clock;

  constructor(options: AnthropicLlmProviderOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey.reveal(),
      baseURL: options.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 60_000,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.routing = options.routing ?? createModelRouting();
    this.clock = options.clock ?? systemClock;
  }

  async complete(request: LlmRequest): Promise<Result<LlmResponse, LlmError>> {
    const checked = checkLlmRequest(request);
    if (!checked.ok) return err(checked.error);
    const sent = await this.send(checked.value, undefined);
    if (!sent.ok) return sent;
    const response = this.toResponse(checked.value, sent.value);
    if (response.stopReason === 'refusal') return err(refused(sent.value, response));
    return ok(response);
  }

  async completeStructured<T>(
    request: LlmRequest,
    schema: z.ZodType<T>,
  ): Promise<Result<StructuredLlmResponse<T>, LlmError>> {
    const checked = checkLlmRequest(request);
    if (!checked.ok) return err(checked.error);
    const sent = await this.send(checked.value, zodOutputFormat(schema));
    if (!sent.ok) return sent;
    const response = this.toResponse(checked.value, sent.value);
    const attempt = attemptOf(response);
    if (response.stopReason === 'refusal') return err(refused(sent.value, response));
    if (response.stopReason === 'max_tokens') {
      return err(
        new LlmError('TRUNCATED', 'The model hit the token limit before completing its answer.', {
          attempt,
          details: { maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS[request.tier] },
        }),
      );
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(response.text);
    } catch (cause) {
      return err(
        new LlmError('BAD_RESPONSE', 'The model output was not valid JSON.', { cause, attempt }),
      );
    }
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      return err(
        new LlmError('BAD_RESPONSE', 'The model output did not match the expected schema.', {
          attempt,
          details: {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join('.'),
              message: issue.message,
            })),
          },
        }),
      );
    }
    return ok({ ...response, output: parsed.data });
  }

  private async send(
    request: LlmRequest,
    format: OutputFormat | undefined,
  ): Promise<Result<Exchange, LlmError>> {
    const model = this.routing.modelFor(request.tier);
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS[request.tier],
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      ...(request.system === undefined ? {} : { system: request.system }),
      ...thinkingParam(request.reasoning),
      ...(format === undefined ? {} : { output_config: { format } }),
      ...(request.tenantId === null ? {} : { metadata: { user_id: request.tenantId } }),
    };
    const started = this.clock.now().getTime();
    try {
      const { data, response } = await this.client.messages.create(params).withResponse();
      return ok({
        message: data,
        latencyMs: Math.max(0, this.clock.now().getTime() - started),
        requestId: response.headers.get('request-id') ?? undefined,
      });
    } catch (error) {
      return err(
        mapAnthropicError(error, model, Math.max(0, this.clock.now().getTime() - started)),
      );
    }
  }

  private toResponse(request: LlmRequest, exchange: Exchange): LlmResponse {
    const { message } = exchange;
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return {
      provider: this.name,
      model: message.model,
      tier: request.tier,
      text,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      stopReason: stopReasonOf(message.stop_reason),
      latencyMs: exchange.latencyMs,
      providerRequestId: exchange.requestId,
      cached: false,
    };
  }
}

function thinkingParam(
  reasoning: LlmRequest['reasoning'],
): Pick<Anthropic.MessageCreateParamsNonStreaming, 'thinking'> {
  switch (reasoning) {
    case undefined:
      return {};
    case 'none':
      return { thinking: { type: 'disabled' } };
    case 'adaptive':
      return { thinking: { type: 'adaptive' } };
  }
}

function stopReasonOf(reason: Anthropic.StopReason | null): LlmStopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    case 'tool_use':
    case 'pause_turn':
    case null:
      return 'other';
  }
}

function attemptOf(response: LlmResponse): LlmAttempt {
  return {
    model: response.model,
    usage: response.usage,
    latencyMs: response.latencyMs,
    providerRequestId: response.providerRequestId,
  };
}

function refused(exchange: Exchange, response: LlmResponse): LlmError {
  const category = exchange.message.stop_details?.category ?? null;
  return new LlmError('REFUSED', 'The model declined to answer this request.', {
    attempt: attemptOf(response),
    details: category === null ? {} : { category },
  });
}

/** Vendor exceptions become typed `LlmError` values; messages are snippets, never full bodies. */
export function mapAnthropicError(error: unknown, model: string, latencyMs: number): LlmError {
  const attempt: LlmAttempt = {
    model,
    usage: ZERO_USAGE,
    latencyMs,
    providerRequestId:
      error instanceof Anthropic.APIError ? (error.requestID ?? undefined) : undefined,
  };
  if (error instanceof Anthropic.APIError) {
    // `status` is generic on APIError (`any` at this narrowing); read it as a number or null.
    const status: number | null = typeof error.status === 'number' ? error.status : null;
    const details = {
      status,
      providerType: error.type,
      providerMessage: safeSnippet(error.message, 300),
    };
    if (error instanceof Anthropic.RateLimitError) {
      return new LlmError('RATE_LIMITED', 'The AI provider rate-limited this request.', {
        attempt,
        details,
        cause: error,
      });
    }
    if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError ||
      error.type === 'billing_error'
    ) {
      return new LlmError('AUTHENTICATION', "The AI provider rejected DOLMIR's credentials.", {
        attempt,
        details,
        cause: error,
      });
    }
    if (
      error instanceof Anthropic.BadRequestError ||
      error instanceof Anthropic.UnprocessableEntityError ||
      error instanceof Anthropic.NotFoundError
    ) {
      return new LlmError('INVALID_REQUEST', 'The AI provider rejected the request.', {
        attempt,
        details,
        cause: error,
      });
    }
    if (
      error instanceof Anthropic.APIConnectionError ||
      error instanceof Anthropic.APIUserAbortError ||
      error instanceof Anthropic.InternalServerError ||
      (status !== null && status >= 500)
    ) {
      return new LlmError('PROVIDER_UNAVAILABLE', 'The AI provider could not be reached.', {
        attempt,
        details,
        cause: error,
      });
    }
    return new LlmError('UNKNOWN', 'The AI provider returned an unexpected error.', {
      attempt,
      details,
      cause: error,
    });
  }
  return new LlmError('UNKNOWN', 'The AI call failed unexpectedly.', {
    attempt,
    cause: error,
    details: {
      providerMessage: safeSnippet(error instanceof Error ? error.message : String(error), 300),
    },
  });
}
