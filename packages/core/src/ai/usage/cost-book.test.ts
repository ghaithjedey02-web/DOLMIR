import { describe, expect, it } from 'vitest';

import { CostBook, DEFAULT_COST_BOOK } from './cost-book.js';

describe('CostBook', () => {
  it('prices tokens per million with cache multipliers, rounded to 8 decimals', () => {
    const estimate = DEFAULT_COST_BOOK.estimate('claude-sonnet-5', {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    // 2 (input) + 0.2 (cache read at 0.1x) + 1 (output) USD
    expect(estimate).toEqual({
      estimatedCost: 3.2,
      currency: 'USD',
      pricingVersion: 1,
      priced: true,
    });
    const tiny = DEFAULT_COST_BOOK.estimate('claude-opus-5', {
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(tiny.estimatedCost).toBe(0.000005);
  });

  it('records an explicit zero for unpriced models instead of guessing', () => {
    const estimate = DEFAULT_COST_BOOK.estimate('some-unknown-model', {
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(estimate).toEqual({
      estimatedCost: 0,
      currency: 'USD',
      pricingVersion: 1,
      priced: false,
    });
  });

  it('layers overrides under a new version', () => {
    const book = new CostBook({ version: 1, prices: {} }).withPrices(2, {
      'fake-fast': {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 5,
        cacheReadMultiplier: 0.1,
        cacheWriteMultiplier: 1.25,
      },
    });
    expect(book.version).toBe(2);
    expect(
      book.estimate('fake-fast', {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 1000,
      }),
    ).toEqual({ estimatedCost: 0.00725, currency: 'USD', pricingVersion: 2, priced: true });
  });
});
