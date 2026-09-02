/**
 * Time is injected, never read from the system inside domain or application
 * code. This keeps tests deterministic and makes replay and backfill possible
 * without touching business logic.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export class FixedClock implements Clock {
  private current: Date;

  constructor(initial: Date = new Date('2026-01-01T00:00:00.000Z')) {
    this.current = new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(next: Date): void {
    this.current = new Date(next.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
