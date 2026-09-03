import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Secret } from '../../../infrastructure/config/secret.js';
import { newOrganizationId } from '../../../kernel/ids.js';
import { createModelRouting } from '../../llm/model-routing.js';
import type { LlmRequest } from '../../llm/port.js';
import { AnthropicLlmProvider, type HttpFetch } from './anthropic-llm-provider.js';

const tenantId = newOrganizationId();
const request: LlmRequest = {
  tenantId,
  tier: 'fast',
  operation: 'classify_message',
  useCase: 'commercial_inbox',
  system: 'Classify the message.',
  messages: [{ role: 'user', content: 'Preventivo per 250 flange tornite.' }],
  maxTokens: 200,
};

interface Captured {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

/** A fetch that answers every call with the same status and JSON body, capturing what was sent. */
function fetchReturning(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): { fetch: HttpFetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: HttpFetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'request-id': 'req_test_1', ...headers },
    });
  };
  return { fetch, calls };
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: '{"category":"rdo"}', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: {
      input_tokens: 120,
      output_tokens: 9,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 60,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
    },
    ...overrides,
  };
}

function apiError(type: string, text = 'provider message'): Record<string, unknown> {
  return { type: 'error', error: { type, message: text }, request_id: 'req_err' };
}

function provider(fetch: HttpFetch): AnthropicLlmProvider {
  return new AnthropicLlmProvider({
    apiKey: new Secret('test-key'),
    fetch,
    maxRetries: 0,
    routing: createModelRouting({ fast: 'claude-haiku-4-5' }),
  });
}

describe('AnthropicLlmProvider', () => {
  it('sends the routed model, the system prompt, the tenant as metadata and no sampling parameters', async () => {
    const { fetch, calls } = fetchReturning(200, message());
    const result = await provider(fetch).complete({ ...request, reasoning: 'adaptive' });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.method).toBe('POST');
    expect(call.headers.get('x-api-key')).toBe('test-key');
    expect(call.body).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: 'Classify the message.',
      messages: [{ role: 'user', content: 'Preventivo per 250 flange tornite.' }],
      thinking: { type: 'adaptive' },
      metadata: { user_id: tenantId },
    });
    expect(call.body).not.toHaveProperty('temperature');
    expect(call.body).not.toHaveProperty('output_config');
  });

  it('maps the response: text, usage including cache tokens, model and request id', async () => {
    const { fetch } = fetchReturning(200, message());
    const result = await provider(fetch).complete(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      tier: 'fast',
      text: '{"category":"rdo"}',
      usage: { inputTokens: 120, outputTokens: 9, cacheReadTokens: 60, cacheWriteTokens: 30 },
      stopReason: 'end_turn',
      providerRequestId: 'req_test_1',
      cached: false,
    });
  });

  it('requests structured output with a JSON schema and validates the answer itself', async () => {
    const { fetch, calls } = fetchReturning(200, message());
    const schema = z.object({ category: z.enum(['rdo', 'order', 'other']) });
    const result = await provider(fetch).completeStructured(request, schema);
    expect(result.ok && result.value.output).toEqual({ category: 'rdo' });
    expect(calls[0]!.body).toMatchObject({
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    });

    const mismatch = await provider(fetch).completeStructured(
      request,
      z.object({ category: z.enum(['order']) }),
    );
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.error.kind).toBe('BAD_RESPONSE');
    expect(mismatch.error.attempt?.usage.inputTokens).toBe(120);
  });

  it('treats refusals and truncated structured answers as typed failures that still carry usage', async () => {
    const refusing = fetchReturning(
      200,
      message({
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'general_harms', explanation: null },
      }),
    );
    const refused = await provider(refusing.fetch).complete(request);
    expect(!refused.ok && refused.error.kind).toBe('REFUSED');
    expect(!refused.ok && refused.error.details).toEqual({ category: 'general_harms' });

    const cut = fetchReturning(
      200,
      message({
        content: [{ type: 'text', text: '{"category":"r', citations: null }],
        stop_reason: 'max_tokens',
      }),
    );
    const truncated = await provider(cut.fetch).completeStructured(
      request,
      z.object({ category: z.string() }),
    );
    expect(!truncated.ok && truncated.error.kind).toBe('TRUNCATED');
    expect(!truncated.ok && truncated.error.attempt?.usage.outputTokens).toBe(9);
    // For free text, hitting the limit is reported, not failed.
    const partial = await provider(cut.fetch).complete(request);
    expect(partial.ok && partial.value.stopReason).toBe('max_tokens');
  });

  it('maps provider errors to typed kinds without leaking bodies', async () => {
    const cases: [number, string, string, boolean][] = [
      [429, 'rate_limit_error', 'RATE_LIMITED', true],
      [401, 'authentication_error', 'AUTHENTICATION', false],
      [403, 'permission_error', 'AUTHENTICATION', false],
      [400, 'invalid_request_error', 'INVALID_REQUEST', false],
      [404, 'not_found_error', 'INVALID_REQUEST', false],
      [500, 'api_error', 'PROVIDER_UNAVAILABLE', true],
      [529, 'overloaded_error', 'PROVIDER_UNAVAILABLE', true],
    ];
    for (const [status, type, kind, retryable] of cases) {
      const { fetch } = fetchReturning(status, apiError(type, 'details from provider'));
      const result = await provider(fetch).complete(request);
      expect(result.ok, `${status} should fail`).toBe(false);
      if (result.ok) continue;
      expect(result.error.kind, `${status}`).toBe(kind);
      expect(result.error.retryable, `${status}`).toBe(retryable);
      expect(result.error.attempt?.model).toBe('claude-haiku-4-5');
      expect(result.error.details).toMatchObject({ status, providerType: type });
      expect(result.error.message).not.toContain('details from provider');
    }
  });

  it('treats network failures as PROVIDER_UNAVAILABLE and never throws', async () => {
    const failing: HttpFetch = async () => {
      throw new TypeError('fetch failed');
    };
    const result = await provider(failing).complete(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('PROVIDER_UNAVAILABLE');
    expect(result.error.retryable).toBe(true);
  });

  it('rejects invalid requests locally without calling the provider', async () => {
    const { fetch, calls } = fetchReturning(200, message());
    const result = await provider(fetch).complete({ ...request, messages: [] });
    expect(!result.ok && result.error.kind).toBe('INVALID_REQUEST');
    expect(calls).toHaveLength(0);
  });
});
