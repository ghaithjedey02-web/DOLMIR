import type { LlmTier } from './port.js';

/**
 * Tier → model routing (Directive §19, plan §I). Callers name a tier; the
 * routing table names the model. Defaults are Anthropic ids because Anthropic
 * is the only real adapter in Phase 0 (ADR-0006); configuration overrides
 * them per tier. Cheap tiers for classification, `standard` for extraction,
 * `deep` reserved for reasoning that earns its cost.
 */
export const DEFAULT_MODELS: Readonly<Record<LlmTier, string>> = {
  fast: 'claude-haiku-4-5',
  standard: 'claude-sonnet-5',
  deep: 'claude-opus-5',
};

export const DEFAULT_MAX_TOKENS: Readonly<Record<LlmTier, number>> = {
  fast: 1024,
  standard: 4096,
  deep: 8192,
};

export type ModelOverrides = Readonly<Partial<Record<LlmTier, string | undefined>>>;

export interface ModelRouting {
  readonly table: Readonly<Record<LlmTier, string>>;
  modelFor(tier: LlmTier): string;
}

export function createModelRouting(overrides: ModelOverrides = {}): ModelRouting {
  const table: Readonly<Record<LlmTier, string>> = {
    fast: overrides.fast ?? DEFAULT_MODELS.fast,
    standard: overrides.standard ?? DEFAULT_MODELS.standard,
    deep: overrides.deep ?? DEFAULT_MODELS.deep,
  };
  return { table, modelFor: (tier) => table[tier] };
}
