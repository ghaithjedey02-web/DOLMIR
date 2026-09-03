import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FixedClock } from '../../kernel/clock.js';
import { newOrganizationId } from '../../kernel/ids.js';
import { InMemoryCompletionCache } from './cache.js';
import { CachingLlmProvider } from './caching-llm-provider.js';
import { FakeLlmProvider } from './fake-llm-provider.js';
import type { LlmRequest } from './port.js';

const request: LlmRequest = {
  tenantId: newOrganizationId(),
  tier: 'fast',
  operation: 'classify_message',
  useCase: 'commercial_inbox',
  messages: [{ role: 'user', content: 'Preventivo per 250 flange.' }],
};
const Classification = z.object({ category: z.enum(['rdo', 'other']) });

function setup() {
  const clock = new FixedClock(new Date('2026-09-02T10:00:00.000Z'));
  const inner = new FakeLlmProvider();
  const cache = new InMemoryCompletionCache({ clock, ttlMs: 60_000, maxEntries: 2 });
  const provider = new CachingLlmProvider({ inner, cache, clock });
  return { clock, inner, cache, provider };
}

describe('CachingLlmProvider', () => {
  it('serves an identical request from the cache with zero usage and cached=true', async () => {
    const { inner, provider } = setup();
    inner.enqueue({ text: 'rdo' }, { text: 'never reached' });
    const first = await provider.complete(request);
    const second = await provider.complete(request);
    expect(first.ok && !first.value.cached).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toMatchObject({ text: 'rdo', cached: true });
    expect(second.value.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(inner.requests).toHaveLength(1);
  });

  it('never shares entries across tenants', async () => {
    const { inner, provider } = setup();
    inner.enqueue({ text: 'a' }, { text: 'b' });
    await provider.complete(request);
    const other = await provider.complete({ ...request, tenantId: newOrganizationId() });
    expect(other.ok && other.value).toMatchObject({ text: 'b', cached: false });
    expect(inner.requests).toHaveLength(2);
  });

  it('caches structured outputs and re-validates them on the way out', async () => {
    const { inner, provider } = setup();
    inner.enqueue({ output: { category: 'rdo' } });
    const first = await provider.completeStructured(request, Classification);
    const second = await provider.completeStructured(request, Classification);
    expect(first.ok && first.value.output).toEqual({ category: 'rdo' });
    expect(second.ok && second.value.cached).toBe(true);
    expect(second.ok && second.value.output).toEqual({ category: 'rdo' });
    // A different schema is a different key.
    inner.enqueue({ output: { category: 'rdo', extra: 1 } });
    const third = await provider.completeStructured(
      request,
      Classification.extend({ extra: z.number() }),
    );
    expect(third.ok && !third.value.cached).toBe(true);
    expect(inner.requests).toHaveLength(2);
  });

  it('expires entries after the ttl and does not cache incomplete answers', async () => {
    const { clock, inner, provider } = setup();
    inner.enqueue({ text: 'first' }, { text: 'second' });
    await provider.complete(request);
    clock.advance(60_001);
    const late = await provider.complete(request);
    expect(late.ok && late.value).toMatchObject({ text: 'second', cached: false });

    const truncatedRequest = { ...request, operation: 'summarize' };
    inner.enqueue({ text: 'cut', stopReason: 'max_tokens' }, { text: 'cut again' });
    await provider.complete(truncatedRequest);
    const again = await provider.complete(truncatedRequest);
    expect(again.ok && again.value.cached).toBe(false);
  });
});
