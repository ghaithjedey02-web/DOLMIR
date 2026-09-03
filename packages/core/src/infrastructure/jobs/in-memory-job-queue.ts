import { type Clock, systemClock } from '../../kernel/clock.js';
import { InternalError } from '../../kernel/errors.js';
import { newUuid } from '../../kernel/ids.js';
import {
  type EnqueueOptions,
  InvalidJobPayloadError,
  type JobContext,
  type JobDefinition,
  type JobHandler,
  type JobName,
  type JobQueuePort,
  type JobRef,
  type ScheduleOptions,
  parseJobPayload,
} from '../../kernel/jobs.js';

/**
 * The queue for tests and the end-to-end chain: jobs are stored in memory and
 * run when the test calls `drain()`, through the same handlers production
 * registers. Retries, idempotency keys and delays behave as in pg-boss;
 * cron expressions are recorded, not evaluated (`fireSchedules()` runs them).
 */
export type InMemoryJobState = 'queued' | 'completed' | 'failed';

export interface InMemoryJob {
  readonly id: string;
  readonly name: JobName;
  readonly payload: unknown;
  readonly idempotencyKey: string | undefined;
  readonly startAfter: Date;
  readonly retryLimit: number;
  attempts: number;
  state: InMemoryJobState;
  lastError: string | undefined;
}

export interface InMemorySchedule {
  readonly name: JobName;
  readonly cron: string;
  readonly payload: unknown;
  readonly key: string | undefined;
  readonly tz: string | undefined;
}

export interface DrainReport {
  readonly completed: number;
  readonly failed: number;
  readonly retried: number;
  /** Jobs still queued when draining stopped (delayed into the future, or rounds exhausted). */
  readonly remaining: number;
}

interface RegisteredHandler {
  parse(raw: unknown): unknown;
  run(payload: unknown, context: JobContext): Promise<void>;
}

export class InMemoryJobQueue implements JobQueuePort {
  readonly jobs: InMemoryJob[] = [];
  readonly schedules: InMemorySchedule[] = [];
  private readonly handlers = new Map<JobName, RegisteredHandler>();
  private readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  async enqueue<T extends object>(
    job: JobDefinition<T>,
    payload: T,
    options: EnqueueOptions = {},
  ): Promise<JobRef> {
    const validated = parseJobPayload(job, payload);
    if (options.idempotencyKey !== undefined) {
      const existing = this.jobs.find(
        (item) =>
          item.name === job.name &&
          item.idempotencyKey === options.idempotencyKey &&
          item.state === 'queued',
      );
      if (existing !== undefined) return { id: null, name: job.name, deduplicated: true };
    }
    const stored: InMemoryJob = {
      id: newUuid(),
      name: job.name,
      payload: validated,
      idempotencyKey: options.idempotencyKey,
      startAfter: new Date(this.clock.now().getTime() + (options.delaySeconds ?? 0) * 1000),
      retryLimit: options.retryLimit ?? job.retryLimit,
      attempts: 0,
      state: 'queued',
      lastError: undefined,
    };
    this.jobs.push(stored);
    return { id: stored.id, name: job.name, deduplicated: false };
  }

  async work<T extends object>(job: JobDefinition<T>, handler: JobHandler<T>): Promise<void> {
    if (this.handlers.has(job.name)) {
      throw new InternalError(
        'DUPLICATE_JOB_HANDLER',
        `A handler for job ${job.name} is already registered.`,
      );
    }
    this.handlers.set(job.name, {
      parse: (raw) => parseJobPayload(job, raw),
      run: (payload, context) => handler(payload as T, context),
    });
  }

  async schedule<T extends object>(
    job: JobDefinition<T>,
    cron: string,
    payload: T,
    options: ScheduleOptions = {},
  ): Promise<void> {
    const validated = parseJobPayload(job, payload);
    const index = this.schedules.findIndex(
      (item) => item.name === job.name && item.key === options.key,
    );
    const entry: InMemorySchedule = {
      name: job.name,
      cron,
      payload: validated,
      key: options.key,
      tz: options.tz,
    };
    if (index >= 0) this.schedules[index] = entry;
    else this.schedules.push(entry);
  }

  async unschedule(job: { readonly name: JobName }, key?: string): Promise<void> {
    for (let i = this.schedules.length - 1; i >= 0; i -= 1) {
      const item = this.schedules[i];
      if (item?.name === job.name && (key === undefined || item.key === key)) {
        this.schedules.splice(i, 1);
      }
    }
  }

  /** Jobs waiting to run. */
  pending(): readonly InMemoryJob[] {
    return this.jobs.filter((job) => job.state === 'queued');
  }

  /**
   * Runs every job that is due, and the jobs those runs enqueue, until nothing
   * is due or `maxRounds` is reached. A failing job is retried in the next
   * round until its retry limit; an invalid payload fails at once.
   */
  async drain(maxRounds = 50): Promise<DrainReport> {
    let completed = 0;
    let failed = 0;
    let retried = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      const now = this.clock.now().getTime();
      const due = this.jobs.filter(
        (job) => job.state === 'queued' && job.startAfter.getTime() <= now,
      );
      if (due.length === 0) break;
      for (const job of due) {
        const outcome = await this.runOne(job);
        if (outcome === 'completed') completed += 1;
        else if (outcome === 'failed') failed += 1;
        else retried += 1;
      }
    }
    return { completed, failed, retried, remaining: this.pending().length };
  }

  /** Enqueues every schedule once, as if its cron had fired now. */
  async fireSchedules(): Promise<number> {
    for (const schedule of this.schedules) {
      this.jobs.push({
        id: newUuid(),
        name: schedule.name,
        payload: schedule.payload,
        idempotencyKey: schedule.key === undefined ? undefined : `schedule:${schedule.key}`,
        startAfter: this.clock.now(),
        retryLimit: 0,
        attempts: 0,
        state: 'queued',
        lastError: undefined,
      });
    }
    return this.schedules.length;
  }

  private async runOne(job: InMemoryJob): Promise<'completed' | 'failed' | 'retried'> {
    const registered = this.handlers.get(job.name);
    if (registered === undefined) {
      job.state = 'failed';
      job.lastError = 'NO_HANDLER';
      return 'failed';
    }
    job.attempts += 1;
    try {
      const payload = registered.parse(job.payload);
      await registered.run(payload, { id: job.id, name: job.name, attempt: job.attempts });
      job.state = 'completed';
      return 'completed';
    } catch (error) {
      job.lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (error instanceof InvalidJobPayloadError || job.attempts > job.retryLimit) {
        job.state = 'failed';
        return 'failed';
      }
      return 'retried';
    }
  }
}
