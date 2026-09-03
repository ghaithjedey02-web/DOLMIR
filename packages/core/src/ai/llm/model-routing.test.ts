import { describe, expect, it } from 'vitest';

import { DEFAULT_MODELS, createModelRouting } from './model-routing.js';

describe('model routing', () => {
  it('routes every tier to a conservative default', () => {
    const routing = createModelRouting();
    expect(routing.table).toEqual(DEFAULT_MODELS);
    expect(routing.modelFor('fast')).toBe(DEFAULT_MODELS.fast);
  });

  it('applies configured overrides per tier and ignores undefined ones', () => {
    const routing = createModelRouting({ standard: 'claude-opus-5', deep: undefined });
    expect(routing.modelFor('standard')).toBe('claude-opus-5');
    expect(routing.modelFor('deep')).toBe(DEFAULT_MODELS.deep);
    expect(routing.modelFor('fast')).toBe(DEFAULT_MODELS.fast);
  });
});
