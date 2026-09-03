import { z } from 'zod';

import { ErrorCategory, DomainError, validationErrorFromZod } from './errors.js';

/**
 * Background work (ADR-0014). A job is a named, versioned payload of small
 * references — ids, never documents — validated on both sides of the queue.
 * Tenant-bound jobs carry their tenant id so the handler re-enters that
 * tenant's scope before touching data. The queue is a port: pg-boss is the
 * production adapter; an in-memory adapter runs the same handlers
 * synchronously in tests and in the end-to-end chain.
 */
export const JobNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'job name must look like area.verb');
export type JobName = z.infer<typeof JobNameSchema>;

export interface JobDefinition<T extends object> {
  readonly name: JobName;
  readonly payload: z.ZodType<T>;
  /** Attempts after the first failure. */
  readonly retryLimit: number;
  /** Seconds between attempts (adapters back off exponentially from here). */
  readonly retryDelaySeconds: number;
  /** A job still running after this long is failed and retried. */
  readonly expireInSeconds: number;
}

export interface DefineJobInput<T extends object> {
  readonly name: string;
  readonly payload: z.ZodType<T>;
  readonly retryLimit?: number;
  readonly retryDelaySeconds?: number;
  readonly expireInSeconds?: number;
}

export function defineJob<T extends object>(input: DefineJobInput<T>): JobDefinition<T> {
  const name = JobNameSchema.safeParse(input.name);
  if (!name.success) {
    throw validationErrorFromZod(
      name.error,
      'INVALID_JOB_NAME',
      `"${input.name}" is not a job name.`,
    );
  }
  return Object.freeze({
    name: name.data,
    payload: input.payload,
    retryLimit: input.retryLimit ?? 3,
    retryDelaySeconds: input.retryDelaySeconds ?? 30,
    expireInSeconds: input.expireInSeconds ?? 15 * 60,
  });
}

export interface EnqueueOptions {
  /** Same key → one job, however many times it is enqueued while that job is queued or running. */
  readonly idempotencyKey?: string;
  /** Do not start before this many seconds have passed. */
  readonly delaySeconds?: number;
  /** Overrides the definition's retry limit for this job. */
  readonly retryLimit?: number;
}

export interface JobRef {
  /** `null` when the idempotency key matched an existing job and nothing was created. */
  readonly id: string | null;
  readonly name: JobName;
  readonly deduplicated: boolean;
}

export interface JobContext {
  readonly id: string;
  readonly name: JobName;
  /** 1 for the first run. */
  readonly attempt: number;
}

export type JobHandler<T extends object> = (payload: T, context: JobContext) => Promise<void>;

export interface ScheduleOptions {
  /** IANA time zone the cron expression is evaluated in. Default UTC. */
  readonly tz?: string;
  /** Distinguishes several schedules of the same job (one per connection, say). */
  readonly key?: string;
}

export interface JobQueuePort {
  enqueue<T extends object>(
    job: JobDefinition<T>,
    payload: T,
    options?: EnqueueOptions,
  ): Promise<JobRef>;
  /** Registers the handler for a job. One handler per job name per process. */
  work<T extends object>(job: JobDefinition<T>, handler: JobHandler<T>): Promise<void>;
  schedule<T extends object>(
    job: JobDefinition<T>,
    cron: string,
    payload: T,
    options?: ScheduleOptions,
  ): Promise<void>;
  unschedule(job: { readonly name: JobName }, key?: string): Promise<void>;
}

/** Raised when a payload does not match its job definition; never retried. */
export class InvalidJobPayloadError extends DomainError {
  constructor(job: JobName, cause: DomainError) {
    super(ErrorCategory.INTERNAL, 'INVALID_JOB_PAYLOAD', `The payload of job ${job} is invalid.`, {
      details: { job, issues: cause.details },
      cause,
    });
  }
}

export function parseJobPayload<T extends object>(job: JobDefinition<T>, raw: unknown): T {
  const parsed = job.payload.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidJobPayloadError(job.name, validationErrorFromZod(parsed.error));
  }
  return parsed.data;
}
