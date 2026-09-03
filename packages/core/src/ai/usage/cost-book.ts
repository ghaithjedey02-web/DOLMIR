import type { LlmUsage } from '../llm/port.js';

/**
 * Prices per model, versioned (plan §O, ADR-0006 §6). USD per million tokens;
 * cache reads and writes are multiples of the input price. A model missing
 * from the book is *unpriced*: its calls record tokens and an explicit zero
 * estimate with `priced = false`, so the gap is visible in reports instead of
 * being hidden by a guess. Overrides carry their own version.
 */
export interface ModelPrice {
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  /** Fraction of the input price charged for cached input tokens read. */
  readonly cacheReadMultiplier: number;
  /** Fraction of the input price charged for cache writes (5-minute cache). */
  readonly cacheWriteMultiplier: number;
}

export interface CostBookData {
  readonly version: number;
  readonly prices: Readonly<Record<string, ModelPrice>>;
}

export interface CostEstimate {
  readonly estimatedCost: number;
  readonly currency: 'USD';
  readonly pricingVersion: number;
  readonly priced: boolean;
}

const COST_DECIMALS = 8;

export class CostBook {
  private readonly data: CostBookData;

  constructor(data: CostBookData) {
    this.data = data;
  }

  get version(): number {
    return this.data.version;
  }

  priceFor(model: string): ModelPrice | undefined {
    return this.data.prices[model];
  }

  estimate(model: string, usage: LlmUsage): CostEstimate {
    const price = this.priceFor(model);
    if (price === undefined) {
      return {
        estimatedCost: 0,
        currency: 'USD',
        pricingVersion: this.data.version,
        priced: false,
      };
    }
    const inputCost =
      (usage.inputTokens +
        usage.cacheReadTokens * price.cacheReadMultiplier +
        usage.cacheWriteTokens * price.cacheWriteMultiplier) *
      price.inputUsdPerMillion;
    const outputCost = usage.outputTokens * price.outputUsdPerMillion;
    const raw = (inputCost + outputCost) / 1_000_000;
    const factor = 10 ** COST_DECIMALS;
    return {
      estimatedCost: Math.round(raw * factor) / factor,
      currency: 'USD',
      pricingVersion: this.data.version,
      priced: true,
    };
  }

  /** A new book with these prices layered over the current ones, under a new version. */
  withPrices(version: number, prices: Readonly<Record<string, ModelPrice>>): CostBook {
    return new CostBook({ version, prices: { ...this.data.prices, ...prices } });
  }
}

const STANDARD_CACHE = { cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 } as const;

/**
 * Version 1. Sources: Anthropic model documentation as summarised in the
 * Claude API skill bundled with this toolchain (model-migration.md, 2026):
 * Claude Opus 5 $5 / $25 per million input / output tokens; Claude Sonnet 5
 * $2 / $10; cache reads 0.1× input, cache writes 1.25× input (5-minute
 * cache). `claude-haiku-4-5` is deliberately absent until its price is
 * confirmed from the pricing page — no number is written down without a
 * source. Review against https://platform.claude.com/docs/en/pricing before
 * the first paid deployment and bump the version.
 */
export const DEFAULT_COST_BOOK = new CostBook({
  version: 1,
  prices: {
    'claude-opus-5': { inputUsdPerMillion: 5, outputUsdPerMillion: 25, ...STANDARD_CACHE },
    'claude-sonnet-5': { inputUsdPerMillion: 2, outputUsdPerMillion: 10, ...STANDARD_CACHE },
  },
});
