import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  JobConcurrency,
  PgBossJobQueue,
  analyzeDocumentJob,
  executeRecommendationJob,
  installJobQueue,
  newOrganizationId,
  newUuid,
  noopLogger,
  runtimeRoleFromConnectionString,
} from '@dolmir/core';
import { PLATFORM_JOBS } from '@dolmir/api';

import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

/**
 * The production job runtime against real PostgreSQL.
 *
 * This is the test that would have caught the gap it was written for. Nothing
 * here is mocked: the schema is installed with the owner connection exactly as
 * a deploy does it, and then the queue is worked as `dolmir_app` — the
 * restricted runtime role, the one the API actually connects as. Before this
 * existed, `installJobQueue` had no caller anywhere in the repository, so a
 * deployment configured for pg-boss had no schema, no queues and no grants,
 * and every approved action would have been enqueued into nothing.
 *
 * The two-role split (ADR-0005, ADR-0014) is asserted from both sides: the
 * runtime role can send and work, and cannot create.
 */
const SCHEMA = 'dolmir_jobs';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe('installing the job queue', () => {
  it('creates a queue for every job the platform ships, and is idempotent', async () => {
    const expected = PLATFORM_JOBS.map((job) => job.name).sort();

    const first = await installJobQueue({
      ownerConnectionString: db.ownerUrl,
      schema: SCHEMA,
      runtimeRole: 'dolmir_app',
      jobs: PLATFORM_JOBS,
      logger: noopLogger,
    });
    expect(first.schema).toBe(SCHEMA);
    expect(first.schemaVersion).not.toBeNull();
    expect([...first.queuesCreated].sort()).toEqual(expected);
    expect(first.queuesUpdated).toEqual([]);

    // Every deploy runs this, so running it on an installed database must be a
    // no-op that still reconciles retry and expiry settings.
    const second = await installJobQueue({
      ownerConnectionString: db.ownerUrl,
      schema: SCHEMA,
      runtimeRole: 'dolmir_app',
      jobs: PLATFORM_JOBS,
      logger: noopLogger,
    });
    expect(second.queuesCreated).toEqual([]);
    expect([...second.queuesUpdated].sort()).toEqual(expected);
  }, 60_000);

  it('creates each queue with a policy that enforces what its job declared', async () => {
    // pg-boss holds any number of identical jobs unless the queue refuses
    // them, and it fixes the policy at creation. If this ever regresses,
    // approving twice would enqueue two executions of the same recommendation.
    const rows = await db.ownerPool.query<{ name: string; policy: string }>(
      `SELECT name, policy FROM ${SCHEMA}.queue ORDER BY name`,
    );
    const policies = new Map(rows.rows.map((row) => [row.name, row.policy]));
    for (const job of PLATFORM_JOBS) {
      expect(policies.get(job.name)).toBe(
        job.concurrency === JobConcurrency.ONE_AT_A_TIME ? 'exclusive' : 'standard',
      );
    }
    expect(policies.get('cases.execute_recommendation')).toBe('exclusive');
    expect(policies.get('mailbox.poll')).toBe('standard');
  });

  it('refuses to leave a queue on a policy its job no longer accepts', async () => {
    // A queue's policy cannot be updated in place, so an install that found the
    // wrong one has to stop rather than pretend the promise still holds.
    const parallel = PLATFORM_JOBS.map((job) => ({ ...job, concurrency: JobConcurrency.PARALLEL }));
    await expect(
      installJobQueue({
        ownerConnectionString: db.ownerUrl,
        schema: SCHEMA,
        runtimeRole: 'dolmir_app',
        jobs: parallel,
        logger: noopLogger,
      }),
    ).rejects.toThrow(/must be "standard"/);
  }, 60_000);

  it('grants the runtime role use of the schema and nothing more than use', async () => {
    const privilege = async (kind: string): Promise<boolean> => {
      const result = await db.ownerPool.query<{ granted: boolean }>(
        'SELECT has_schema_privilege($1, $2, $3) AS granted',
        ['dolmir_app', SCHEMA, kind],
      );
      return result.rows[0]?.granted ?? false;
    };
    expect(await privilege('USAGE')).toBe(true);
    // A queue is a table partition, so creating one is the owner's job. The
    // runtime role works queues; it never invents them.
    expect(await privilege('CREATE')).toBe(false);
  });

  it('derives the role to grant from the runtime connection rather than a second setting', () => {
    expect(runtimeRoleFromConnectionString(db.appUrl)).toBe('dolmir_app');
  });
});

describe('the runtime role working the installed queue', () => {
  let queue: PgBossJobQueue;

  afterAll(async () => {
    await queue.stop();
    // Stopping twice is what a shutdown after a failed start looks like.
    await queue.stop();
  });

  it('carries a job from enqueue to handler as dolmir_app', async () => {
    queue = new PgBossJobQueue({
      connectionString: db.appUrl,
      schema: SCHEMA,
      logger: noopLogger,
    });
    await queue.start();
    // Starting twice must not open a second set of connections.
    await queue.start();

    const seen: { tenantId: string; recommendationId: string }[] = [];
    await queue.work(executeRecommendationJob, async (payload) => {
      seen.push(payload);
    });

    const tenantId = newOrganizationId();
    const recommendationId = newUuid();
    const ref = await queue.enqueue(executeRecommendationJob, { tenantId, recommendationId });
    expect(ref.id).not.toBeNull();
    expect(ref.deduplicated).toBe(false);

    await waitFor(() => seen.length === 1, 20_000);
    expect(seen[0]).toEqual({ tenantId, recommendationId });
  }, 30_000);

  it('deduplicates by idempotency key, so approving twice enqueues once', async () => {
    // `document.analyze` has no worker in this test, so the job stays queued
    // and the assertion is about the queue rather than about timing.
    const payload = { tenantId: newOrganizationId(), documentId: newUuid() };
    const key = `analyze:${payload.documentId}`;

    const first = await queue.enqueue(analyzeDocumentJob, payload, { idempotencyKey: key });
    const second = await queue.enqueue(analyzeDocumentJob, payload, { idempotencyKey: key });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBeNull();
  }, 30_000);

  it('refuses to enqueue a payload that does not match its job definition', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a wrong payload is the point
      queue.enqueue(executeRecommendationJob, { tenantId: 'not-a-uuid' } as any),
    ).rejects.toThrow(/payload of job cases.execute_recommendation is invalid/);
  });
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the queue');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
