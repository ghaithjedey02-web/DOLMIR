import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FixedClock } from '../../kernel/clock.js';
import { defineJob } from '../../kernel/jobs.js';
import { InMemoryJobQueue } from './in-memory-job-queue.js';

const greet = defineJob({
  name: 'test.greet',
  payload: z.object({ who: z.string().min(1) }).strict(),
  retryLimit: 1,
});
const flaky = defineJob({
  name: 'test.flaky',
  payload: z.object({ n: z.number() }),
  retryLimit: 2,
});

describe('InMemoryJobQueue', () => {
  it('validates payloads, deduplicates by idempotency key and runs handlers on drain', async () => {
    const clock = new FixedClock(new Date('2026-09-03T12:00:00.000Z'));
    const queue = new InMemoryJobQueue(clock);
    const seen: string[] = [];
    await queue.work(greet, async (payload, context) => {
      seen.push(`${payload.who}#${context.attempt}`);
    });
    expect(() => defineJob({ name: 'NotAJob', payload: z.object({}) })).toThrow();
    await expect(queue.enqueue(greet, { who: '' })).rejects.toMatchObject({
      code: 'INVALID_JOB_PAYLOAD',
    });

    const first = await queue.enqueue(greet, { who: 'a' }, { idempotencyKey: 'greet:a' });
    const again = await queue.enqueue(greet, { who: 'a' }, { idempotencyKey: 'greet:a' });
    expect(first.deduplicated).toBe(false);
    expect(again).toEqual({ id: null, name: 'test.greet', deduplicated: true });
    await queue.enqueue(greet, { who: 'later' }, { delaySeconds: 60 });

    const report = await queue.drain();
    expect(report).toEqual({ completed: 1, failed: 0, retried: 0, remaining: 1 });
    expect(seen).toEqual(['a#1']);

    clock.advance(61_000);
    expect(await queue.drain()).toMatchObject({ completed: 1, remaining: 0 });
    expect(seen).toEqual(['a#1', 'later#1']);
    // The key is free again once the job completed.
    expect(
      (await queue.enqueue(greet, { who: 'a' }, { idempotencyKey: 'greet:a' })).deduplicated,
    ).toBe(false);
  });

  it('retries a failing job up to its limit, then fails it; unknown jobs fail at once', async () => {
    const queue = new InMemoryJobQueue();
    let calls = 0;
    await queue.work(flaky, async () => {
      calls += 1;
      throw new Error('boom');
    });
    await queue.enqueue(flaky, { n: 1 });
    await queue.enqueue(greet, { who: 'nobody' });
    const report = await queue.drain();
    expect(calls).toBe(3);
    expect(report).toEqual({ completed: 0, failed: 2, retried: 2, remaining: 0 });
    expect(queue.jobs.map((j) => [j.name, j.state, j.lastError])).toEqual([
      ['test.flaky', 'failed', 'Error: boom'],
      ['test.greet', 'failed', 'NO_HANDLER'],
    ]);
    await expect(queue.work(flaky, async () => undefined)).rejects.toMatchObject({
      code: 'DUPLICATE_JOB_HANDLER',
    });
  });

  it('records schedules per key and fires them on demand', async () => {
    const queue = new InMemoryJobQueue();
    const seen: string[] = [];
    await queue.work(greet, async (payload) => {
      seen.push(payload.who);
    });
    await queue.schedule(greet, '*/5 * * * *', { who: 'c1' }, { key: 'c1', tz: 'Europe/Rome' });
    await queue.schedule(greet, '*/5 * * * *', { who: 'c2' }, { key: 'c2' });
    await queue.schedule(greet, '*/10 * * * *', { who: 'c1-updated' }, { key: 'c1' });
    expect(queue.schedules.map((s) => [s.key, s.cron])).toEqual([
      ['c1', '*/10 * * * *'],
      ['c2', '*/5 * * * *'],
    ]);
    expect(await queue.fireSchedules()).toBe(2);
    await queue.drain();
    expect(seen.sort()).toEqual(['c1-updated', 'c2']);
    await queue.unschedule(greet, 'c2');
    expect(queue.schedules).toHaveLength(1);
    await queue.unschedule(greet);
    expect(queue.schedules).toHaveLength(0);
  });
});
