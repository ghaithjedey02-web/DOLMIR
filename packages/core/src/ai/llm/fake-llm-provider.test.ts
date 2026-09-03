import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { newOrganizationId } from '../../kernel/ids.js';
import { FakeLlmProvider } from './fake-llm-provider.js';
import { LlmError, type LlmRequest } from './port.js';

const tenantId = newOrganizationId();
const request: LlmRequest = {
  tenantId,
  tier: 'fast',
  operation: 'classify_message',
  useCase: 'commercial_inbox',
  system: 'Classify inbound commercial messages.',
  messages: [{ role: 'user', content: 'Richiesta di offerta per 250 flange tornite.' }],
};
const Classification = z.object({ category: z.enum(['rdo', 'order', 'other']) });

describe('FakeLlmProvider', () => {
  it('returns scripted text with estimated usage and records the request', async () => {
    const provider = new FakeLlmProvider().enqueue({ text: 'rdo' });
    const result = await provider.complete(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      provider: 'fake',
      model: 'fake-fast',
      tier: 'fast',
      text: 'rdo',
      stopReason: 'end_turn',
      cached: false,
    });
    expect(result.value.usage.inputTokens).toBeGreaterThan(0);
    expect(result.value.usage.outputTokens).toBe(1);
    expect(provider.requests).toEqual([request]);
  });

  it('validates structured replies against the schema and fails as BAD_RESPONSE with usage attached', async () => {
    const provider = new FakeLlmProvider().enqueue(
      { output: { category: 'rdo' } },
      { output: { category: 'quote' } },
      { text: 'not json' },
    );
    const good = await provider.completeStructured(request, Classification);
    expect(good.ok && good.value.output).toEqual({ category: 'rdo' });

    const bad = await provider.completeStructured(request, Classification);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.kind).toBe('BAD_RESPONSE');
    expect(bad.error.retryable).toBe(true);
    expect(bad.error.attempt?.model).toBe('fake-fast');
    expect(bad.error.attempt?.usage.outputTokens).toBeGreaterThan(0);
    expect(bad.error.details).toMatchObject({ issues: [{ path: 'category' }] });

    const notJson = await provider.completeStructured(request, Classification);
    expect(!notJson.ok && notJson.error.kind).toBe('BAD_RESPONSE');
  });

  it('fails an unscripted request as PROVIDER_NOT_CONFIGURED instead of inventing an answer', async () => {
    const result = await new FakeLlmProvider().complete(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('PROVIDER_NOT_CONFIGURED');
    expect(result.error.code).toBe('LLM_PROVIDER_NOT_CONFIGURED');
    expect(result.error.category).toBe('precondition_failed');
  });

  it('rejects invalid requests before consulting the script', async () => {
    const provider = new FakeLlmProvider().enqueue({ text: 'never used' });
    const assistantFirst = await provider.complete({
      ...request,
      messages: [{ role: 'assistant', content: 'hi' }],
    });
    expect(!assistantFirst.ok && assistantFirst.error.kind).toBe('INVALID_REQUEST');
    const badName = await provider.complete({ ...request, operation: 'Not Valid' });
    expect(!badName.ok && badName.error.kind).toBe('INVALID_REQUEST');
    expect(provider.requests).toHaveLength(0);
  });

  it('lets a script return typed failures', async () => {
    const provider = new FakeLlmProvider({
      script: () => ({ error: new LlmError('RATE_LIMITED', 'slow down') }),
    });
    const result = await provider.complete(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      kind: 'RATE_LIMITED',
      category: 'rate_limited',
      retryable: true,
    });
  });
});
