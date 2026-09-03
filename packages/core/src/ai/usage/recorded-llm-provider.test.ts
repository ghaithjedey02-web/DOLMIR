import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FixedClock } from '../../kernel/clock.js';
import { noExecutionContext } from '../../kernel/context.js';
import { InfrastructureError } from '../../kernel/errors.js';
import { newOrganizationId } from '../../kernel/ids.js';
import { CapturingLogger } from '../../kernel/logger.js';
import { InMemoryTelemetry } from '../../kernel/telemetry.js';
import { InMemoryTransactionRunner } from '../../modules/tenancy/index.js';
import { InMemoryAiUsageRepository } from '../adapters/memory/in-memory-ai-usage-repository.js';
import { InMemoryCompletionCache } from '../llm/cache.js';
import { CachingLlmProvider } from '../llm/caching-llm-provider.js';
import { FakeLlmProvider } from '../llm/fake-llm-provider.js';
import { LlmError, type LlmRequest } from '../llm/port.js';
import { AiUsageTracker } from './ai-usage-tracker.js';
import { CostBook } from './cost-book.js';
import { RecordedLlmProvider } from './recorded-llm-provider.js';

const tenantId = newOrganizationId();
const request: LlmRequest = {
  tenantId,
  tier: 'fast',
  operation: 'classify_message',
  useCase: 'commercial_inbox',
  messages: [{ role: 'user', content: 'Preventivo per 250 flange tornite in S355.' }],
};
const costBook = new CostBook({
  version: 7,
  prices: {
    'fake-fast': {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 5,
      cacheReadMultiplier: 0.1,
      cacheWriteMultiplier: 1.25,
    },
  },
});

function setup() {
  const clock = new FixedClock(new Date('2026-09-02T10:00:00.000Z'));
  const repository = new InMemoryAiUsageRepository();
  const transactions = new InMemoryTransactionRunner();
  const tracker = new AiUsageTracker({
    repository,
    transactions,
    clock,
    context: noExecutionContext,
  });
  const inner = new FakeLlmProvider();
  const telemetry = new InMemoryTelemetry();
  const logger = new CapturingLogger();
  const provider = new RecordedLlmProvider({
    inner,
    usage: tracker,
    costBook,
    clock,
    telemetry,
    logger,
  });
  return { clock, repository, transactions, tracker, inner, telemetry, logger, provider };
}

describe('RecordedLlmProvider', () => {
  it('writes one priced usage row per successful call and returns the answer unchanged', async () => {
    const { repository, inner, provider, telemetry } = setup();
    inner.enqueue({ text: 'rdo', usage: { inputTokens: 1000, outputTokens: 200 } });
    const result = await provider.complete(request);
    expect(result.ok && result.value.text).toBe('rdo');
    expect(repository.records).toHaveLength(1);
    expect(repository.records[0]).toMatchObject({
      organizationId: tenantId,
      provider: 'fake',
      model: 'fake-fast',
      tier: 'fast',
      operation: 'classify_message',
      useCase: 'commercial_inbox',
      inputTokens: 1000,
      outputTokens: 200,
      estimatedCost: 0.002,
      currency: 'USD',
      pricingVersion: 7,
      priced: true,
      succeeded: true,
      errorKind: null,
      cached: false,
    });
    expect(telemetry.total('ai.calls')).toBe(1);
  });

  it('records failed calls with the tokens the attempt consumed', async () => {
    const { repository, inner, provider } = setup();
    inner.enqueue({
      error: new LlmError('BAD_RESPONSE', 'bad', {
        attempt: {
          model: 'fake-fast',
          usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
          latencyMs: 12,
          providerRequestId: undefined,
        },
      }),
    });
    const result = await provider.completeStructured(request, z.object({ a: z.string() }));
    expect(!result.ok && result.error.kind).toBe('BAD_RESPONSE');
    expect(repository.records[0]).toMatchObject({
      succeeded: false,
      errorKind: 'BAD_RESPONSE',
      inputTokens: 300,
      outputTokens: 40,
      latencyMs: 12,
      priced: true,
    });
  });

  it('records cache hits as zero-cost cached calls', async () => {
    const base = setup();
    const cached = new CachingLlmProvider({
      inner: base.inner,
      cache: new InMemoryCompletionCache({ clock: base.clock }),
      clock: base.clock,
    });
    const provider = new RecordedLlmProvider({
      inner: cached,
      usage: base.tracker,
      costBook,
      clock: base.clock,
    });
    base.inner.enqueue({ text: 'rdo' });
    await provider.complete(request);
    await provider.complete(request);
    expect(base.repository.records.map((r) => r.cached)).toEqual([false, true]);
    expect(base.repository.records[1]).toMatchObject({ inputTokens: 0, estimatedCost: 0 });
  });

  it('records tenant-less calls in an explicit system scope', async () => {
    const { repository, transactions, inner, provider } = setup();
    inner.enqueue({ text: 'ok' });
    await provider.complete({ ...request, tenantId: null });
    expect(repository.records[0]?.organizationId).toBeNull();
    expect(transactions.systemScopeReasons).toEqual(['ai usage without tenant']);
  });

  it('never loses the answer when the usage row cannot be written, but says so loudly', async () => {
    const { inner, telemetry, logger, clock } = setup();
    const provider = new RecordedLlmProvider({
      inner,
      usage: {
        record: async () => {
          throw new InfrastructureError('DB_DOWN', 'down');
        },
      },
      costBook,
      clock,
      telemetry,
      logger,
    });
    inner.enqueue({ text: 'still here' });
    const result = await provider.complete(request);
    expect(result.ok && result.value.text).toBe('still here');
    expect(telemetry.total('ai.usage.record_failed')).toBe(1);
    expect(logger.records.some((r) => r.level === 'error')).toBe(true);
  });

  it('refuses malformed usage records instead of storing them', async () => {
    const { tracker } = setup();
    await expect(
      tracker.record({
        organizationId: tenantId,
        provider: 'fake',
        model: 'fake-fast',
        tier: 'fast',
        operation: 'x',
        useCase: 'y',
        inputTokens: 1,
        outputTokens: 1,
        estimatedCost: 0,
        currency: 'USD',
        pricingVersion: 1,
        priced: true,
        latencyMs: 1,
        succeeded: true,
        errorKind: 'BAD_RESPONSE',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_AI_USAGE_RECORD' });
  });
});
