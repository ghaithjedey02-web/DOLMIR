import Anthropic from '@anthropic-ai/sdk';

import type { Secret } from '../../../infrastructure/config/secret.js';
import { ANTHROPIC_DEFAULT_BASE_URL, type HttpFetch } from './anthropic-llm-provider.js';

/**
 * "Can this deployment reach the model provider, with the key it was given?"
 *
 * Answered with the Models endpoint — a read that costs no tokens, generates
 * nothing, and fails in exactly the ways a first real request would: an
 * unreachable host, a rejected key, a rejected request. Nothing about the key
 * is returned; the SDK receives it and the result describes only the outcome.
 * Preflight is the caller; the provider itself never needs this.
 */
export interface AnthropicProbeOptions {
  readonly apiKey: Secret;
  readonly baseUrl?: string;
  readonly fetch?: HttpFetch;
  /** One attempt, bounded: a probe that hangs is a failed probe. */
  readonly timeoutMs?: number;
}

export type AnthropicProbeResult =
  | {
      readonly ok: true;
      readonly latencyMs: number;
      /** Models visible to this key on the first page; zero is reported, not hidden. */
      readonly models: number;
    }
  | {
      readonly ok: false;
      /** `unauthorized`: the key was refused. `unreachable`: no answer. `rejected`: an answer, and a refusal. */
      readonly kind: 'unauthorized' | 'unreachable' | 'rejected';
      readonly status: number | undefined;
      readonly detail: string;
    };

export async function probeAnthropic(
  options: AnthropicProbeOptions,
): Promise<AnthropicProbeResult> {
  const client = new Anthropic({
    apiKey: options.apiKey.reveal(),
    baseURL: options.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL,
    maxRetries: 0,
    timeout: options.timeoutMs ?? 10_000,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const started = performance.now();
  try {
    const page = await client.models.list({ limit: 1 });
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      models: page.data.length,
    };
  } catch (error) {
    if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    ) {
      return {
        ok: false,
        kind: 'unauthorized',
        status: error.status,
        detail: withoutKey(error.message),
      };
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return {
        ok: false,
        kind: 'unreachable',
        status: undefined,
        detail: withoutKey(error.message),
      };
    }
    if (error instanceof Anthropic.APIError) {
      // The base class leaves the status generic; narrow it before reporting.
      const status: unknown = error.status;
      return {
        ok: false,
        kind: 'rejected',
        status: typeof status === 'number' ? status : undefined,
        detail: withoutKey(error.message),
      };
    }
    return {
      ok: false,
      kind: 'unreachable',
      status: undefined,
      detail: withoutKey(error instanceof Error ? error.message : String(error)),
    };
  }
}

/** The SDK does not echo credentials, and this makes sure a proxy in between cannot either. */
function withoutKey(message: string): string {
  return message.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]');
}
