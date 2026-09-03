import type { z } from 'zod';

import { err, ok, type Result } from '../../kernel/result.js';
import {
  type LlmAttempt,
  LlmError,
  type LlmProviderPort,
  type LlmRequest,
  type LlmResponse,
  type LlmStopReason,
  type LlmUsage,
  type StructuredLlmResponse,
  checkLlmRequest,
  estimateTokens,
} from './port.js';

/**
 * A scripted provider for tests and for local development without a key.
 * It never pretends to be a model: `provider` is `fake`, the model id is
 * `fake-<tier>`, and an unscripted request fails as PROVIDER_NOT_CONFIGURED
 * rather than inventing an answer. Structured replies are validated against
 * the caller's schema exactly as a real adapter would, so a wrong script
 * fails the same way a wrong model output does.
 */
export type FakeReply =
  | {
      readonly text: string;
      readonly usage?: Partial<LlmUsage>;
      readonly stopReason?: LlmStopReason;
    }
  | { readonly output: unknown; readonly usage?: Partial<LlmUsage> }
  | { readonly error: LlmError };

export type FakeScript = (request: LlmRequest, index: number) => FakeReply | undefined;

export interface FakeLlmProviderOptions {
  readonly script?: FakeScript;
  readonly replies?: readonly FakeReply[];
}

export const FAKE_PROVIDER_NAME = 'fake';

export class FakeLlmProvider implements LlmProviderPort {
  readonly name = FAKE_PROVIDER_NAME;
  readonly capabilities = { structuredOutput: true, vision: false } as const;
  /** Every request received, for assertions. */
  readonly requests: LlmRequest[] = [];
  private readonly queue: FakeReply[];
  private readonly script: FakeScript | undefined;

  constructor(options: FakeLlmProviderOptions = {}) {
    this.queue = [...(options.replies ?? [])];
    this.script = options.script;
  }

  enqueue(...replies: FakeReply[]): this {
    this.queue.push(...replies);
    return this;
  }

  async complete(request: LlmRequest): Promise<Result<LlmResponse, LlmError>> {
    const checked = checkLlmRequest(request);
    if (!checked.ok) return err(checked.error);
    const reply = this.next(checked.value);
    if (reply === undefined) return err(this.unscripted(checked.value));
    if ('error' in reply) return err(reply.error);
    const text = 'text' in reply ? reply.text : JSON.stringify(reply.output);
    const stopReason = 'text' in reply ? (reply.stopReason ?? 'end_turn') : 'end_turn';
    return ok(this.response(checked.value, text, reply.usage, stopReason));
  }

  async completeStructured<T>(
    request: LlmRequest,
    schema: z.ZodType<T>,
  ): Promise<Result<StructuredLlmResponse<T>, LlmError>> {
    const checked = checkLlmRequest(request);
    if (!checked.ok) return err(checked.error);
    const reply = this.next(checked.value);
    if (reply === undefined) return err(this.unscripted(checked.value));
    if ('error' in reply) return err(reply.error);

    const text = 'text' in reply ? reply.text : JSON.stringify(reply.output);
    const response = this.response(checked.value, text, reply.usage, 'end_turn');
    const attempt: LlmAttempt = {
      model: response.model,
      usage: response.usage,
      latencyMs: response.latencyMs,
      providerRequestId: undefined,
    };
    let candidate: unknown;
    if ('output' in reply) {
      candidate = reply.output;
    } else {
      try {
        candidate = JSON.parse(reply.text);
      } catch (cause) {
        return err(
          new LlmError('BAD_RESPONSE', 'The model output was not valid JSON.', { cause, attempt }),
        );
      }
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

  private next(request: LlmRequest): FakeReply | undefined {
    const index = this.requests.push(request) - 1;
    const scripted = this.script?.(request, index);
    return scripted ?? this.queue.shift();
  }

  private unscripted(request: LlmRequest): LlmError {
    return new LlmError(
      'PROVIDER_NOT_CONFIGURED',
      `The fake provider has no scripted reply for ${request.operation}.`,
      { details: { provider: this.name, operation: request.operation } },
    );
  }

  private response(
    request: LlmRequest,
    text: string,
    usage: Partial<LlmUsage> | undefined,
    stopReason: LlmStopReason,
  ): LlmResponse {
    const promptText = [request.system ?? '', ...request.messages.map((m) => m.content)].join('\n');
    return {
      provider: this.name,
      model: `fake-${request.tier}`,
      tier: request.tier,
      text,
      usage: {
        inputTokens: usage?.inputTokens ?? estimateTokens(promptText),
        outputTokens: usage?.outputTokens ?? estimateTokens(text),
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      },
      stopReason,
      latencyMs: 0,
      providerRequestId: undefined,
      cached: false,
    };
  }
}
