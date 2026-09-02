import { describe, expect, it } from 'vitest';

import { FixedClock, systemClock } from './clock.js';

describe('Clock', () => {
  it('system clock reads the wall clock', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
  });

  it('fixed clock is deterministic, advances explicitly and hands out copies', () => {
    const clock = new FixedClock(new Date('2026-09-02T10:00:00.000Z'));
    const first = clock.now();
    first.setFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-09-02T10:00:00.000Z');
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-09-02T10:01:00.000Z');
    clock.set(new Date('2027-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
