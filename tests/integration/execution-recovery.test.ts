import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AuditTrail,
  type CaseDraftInput,
  CaseEngine,
  CaseProjection,
  EventLedger,
  InMemoryJobQueue,
  type OrganizationId,
  Permission,
  PersistedActionPolicy,
  PostgresActionIntentRepository,
  PostgresAuditLogRepository,
  PostgresCaseRepository,
  PostgresLedgerRepository,
  PostgresMembershipRepository,
  PostgresOrganizationRepository,
  PostgresPolicyOverrideRepository,
  PostgresTransactionRunner,
  PostgresUserRepository,
  ProvisionOrganization,
  RecoverExecutions,
  type TenantContext,
  ToolEffect,
  ToolExecutor,
  ToolRegistry,
  authorizer,
  defineTool,
  executeRecommendationJob,
  executionJobKey,
  noExecutionContext,
  noopLogger,
  ok,
  systemClock,
} from '@dolmir/core';
import { InfrastructureError } from '@dolmir/core';

import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

/**
 * Recovery of authorised work whose enqueue never happened.
 *
 * The entitlement is committed with the approval, but asking a worker to act
 * on it is a separate step that can be lost: the queue is down, the
 * acknowledgement never arrives, the process dies in between. These tests
 * remove that step deliberately — the scheduler throws, or is simply never
 * called — and then assert that a sweep finds the work, asks for it again, and
 * that doing so twice still sends exactly once.
 *
 * Everything runs against real PostgreSQL and the real job queue, because the
 * guarantees under test are a system-scope read, row-level security, a queue
 * key and a row lock — none of which a stub would reproduce honestly.
 */

const sent: { to: string; idempotencyKey: string | undefined }[] = [];

const sendReply = defineTool({
  name: 'send_reply',
  description: 'Send an approved reply to the customer.',
  effect: ToolEffect.ACT,
  permission: Permission.AI_INVOKE,
  input: z.object({ to: z.email(), body: z.string().min(1) }),
  output: z.object({ messageId: z.string() }),
  handler: async (input, context) => {
    sent.push({ to: input.to, idempotencyKey: context.idempotencyKey });
    return ok({ messageId: `msg-${String(sent.length)}` });
  },
});

/** A queue that can be taken away, as an unavailable one is. */
class FlakyQueue extends InMemoryJobQueue {
  offline = false;

  override async enqueue(
    ...args: Parameters<InMemoryJobQueue['enqueue']>
  ): ReturnType<InMemoryJobQueue['enqueue']> {
    if (this.offline) {
      throw new InfrastructureError('JOB_ENQUEUE_FAILED', 'The queue is unavailable.', {
        retryable: true,
      });
    }
    return super.enqueue(...args);
  }
}

describe('recovery of unfinished executions', () => {
  let db: TestDatabase;
  let transactions: PostgresTransactionRunner;
  let engine: CaseEngine;
  let recovery: RecoverExecutions;
  let queue: FlakyQueue;
  let orgA: OrganizationId;
  let orgB: OrganizationId;
  let tenantA: TenantContext;
  let tenantB: TenantContext;
  const cases = new PostgresCaseRepository();
  const intents = new PostgresActionIntentRepository();

  const draft: CaseDraftInput = {
    kind: 'quote_request',
    title: 'Richiesta di preventivo',
    summary: 'Una richiesta di preventivo da confermare.',
    priority: 'normal',
    determination: 'READY_FOR_REVIEW',
    findings: [],
    recommendations: [
      {
        tool: 'send_reply',
        input: { to: 'acquisti@officine-rossi.it', body: 'Buongiorno, confermiamo la ricezione.' },
        rationale: 'Quote requests receive an acknowledgement.',
      },
    ],
  };

  /**
   * Approves a recommendation while the queue is unavailable, which is exactly
   * the gap under test: the entitlement commits, the enqueue does not happen.
   */
  async function approvedWithoutEnqueue(tenant: TenantContext): Promise<string> {
    const opened = await engine.openCase(tenant.organizationId, draft, {
      systemKey: 'test_inbox',
      systemVersion: 1,
      sourceRef: `document:${crypto.randomUUID()}`,
    });
    if (!opened.ok) throw opened.error;
    const recommendationId = opened.value.recommendations[0]?.id;
    if (recommendationId === undefined) throw new Error('no recommendation');
    queue.offline = true;
    const decided = await engine.decide(tenant, recommendationId, 'approved', 'Va bene.');
    queue.offline = false;
    if (!decided.ok) throw decided.error;
    return recommendationId;
  }

  const intentOf = async (tenant: TenantContext, recommendationId: string) =>
    transactions.withTenant(tenant.organizationId, (scope) =>
      intents.find(scope, recommendationId),
    );

  const queuedFor = (recommendationId: string): number =>
    queue.jobs.filter(
      (job) =>
        job.name === executeRecommendationJob.name &&
        job.idempotencyKey === executionJobKey(recommendationId),
    ).length;

  beforeAll(async () => {
    db = await createTestDatabase();
    transactions = new PostgresTransactionRunner(db.appPool, noopLogger);
    queue = new FlakyQueue(systemClock);
    const audit = new AuditTrail({
      repository: new PostgresAuditLogRepository(),
      clock: systemClock,
      context: noExecutionContext,
    });
    const memberships = new PostgresMembershipRepository();
    const provision = new ProvisionOrganization({
      transactions,
      organizations: new PostgresOrganizationRepository(),
      users: new PostgresUserRepository(),
      memberships,
      audit,
    });
    const a = await provision.execute({
      organization: { slug: 'a', name: 'Alfa Meccanica' },
      owner: { authSubject: 'auth|a' },
    });
    const b = await provision.execute({
      organization: { slug: 'b', name: 'Beta' },
      owner: { authSubject: 'auth|b' },
    });
    if (!a.ok || !b.ok) throw new Error('provisioning failed');
    orgA = a.value.organization.id;
    orgB = b.value.organization.id;
    tenantA = {
      organizationId: orgA,
      organizationSlug: 'a',
      userId: a.value.owner.id,
      roleKey: 'owner',
    };
    tenantB = {
      organizationId: orgB,
      organizationSlug: 'b',
      userId: b.value.owner.id,
      roleKey: 'owner',
    };

    const overrides = new PostgresPolicyOverrideRepository();
    const policy = new PersistedActionPolicy({ transactions, overrides });
    const tools = new ToolRegistry().register(sendReply);
    const scheduler = {
      scheduleExecution: async (tenantId: OrganizationId, recommendationId: string) => {
        await queue.enqueue(
          executeRecommendationJob,
          { tenantId, recommendationId },
          { idempotencyKey: executionJobKey(recommendationId) },
        );
      },
    };
    engine = new CaseEngine({
      transactions,
      ledger: new EventLedger({
        repository: new PostgresLedgerRepository(),
        context: noExecutionContext,
      }),
      cases,
      intents,
      projection: new CaseProjection(cases),
      tools,
      policy,
      executor: new ToolExecutor({
        registry: tools,
        authorizer,
        policy,
        audit,
        clock: systemClock,
      }),
      authorizer,
      memberships,
      clock: systemClock,
      scheduler,
    });
    recovery = new RecoverExecutions({ transactions, intents, scheduler, logger: noopLogger });
    await queue.work(executeRecommendationJob, async (payload) => {
      const executed = await engine.execute(payload.tenantId, payload.recommendationId);
      if (!executed.ok) throw executed.error;
    });
  });

  afterEach(async () => {
    sent.length = 0;
    queue.offline = false;
    queue.jobs.length = 0;
    // Each test asserts on what a sweep finds, so no test may leave unfinished
    // work behind for the next one to trip over.
    for (const organizationId of [orgA, orgB]) {
      await transactions.withTenant(organizationId, async (scope) => {
        for (const intent of await intents.listUnfinished(scope, 200)) {
          await intents.settle(scope, intent.recommendationId, {
            state: 'sent',
            attempts: intent.attempts,
            updatedAt: systemClock.now(),
          });
        }
      });
    }
  });

  afterAll(async () => {
    await db.drop();
  });

  it('re-enqueues work that was authorised while the queue was unavailable', async () => {
    const recommendationId = await approvedWithoutEnqueue(tenantA);
    // The approval committed; the enqueue did not happen. Nothing would ever
    // carry this out without recovery.
    expect(queuedFor(recommendationId)).toBe(0);
    expect(await intentOf(tenantA, recommendationId)).toMatchObject({ state: 'pending' });

    const report = await recovery.execute();
    expect(report).toMatchObject({ found: 1, requeued: 1, failed: 0 });
    expect(queuedFor(recommendationId)).toBe(1);

    const worked = await queue.drain();
    expect(worked.failed).toBe(0);
    expect(sent).toHaveLength(1);
    expect(await intentOf(tenantA, recommendationId)).toMatchObject({ state: 'sent', attempts: 1 });
  });

  it('never re-enqueues an entitlement that has already been carried out', async () => {
    const recommendationId = await approvedWithoutEnqueue(tenantA);
    await recovery.execute();
    await queue.drain();
    expect(sent).toHaveLength(1);
    queue.jobs.length = 0;

    // Nothing is unfinished any more, so the sweep finds nothing to do.
    const report = await recovery.execute();
    expect(report).toMatchObject({ tenants: 0, found: 0, requeued: 0 });
    expect(queuedFor(recommendationId)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('sends exactly once however many times recovery runs', async () => {
    const recommendationId = await approvedWithoutEnqueue(tenantA);

    // Three sweeps before anything is worked: the queue key collapses them.
    await recovery.execute();
    await recovery.execute();
    await recovery.execute();
    expect(queuedFor(recommendationId)).toBe(1);

    await queue.drain();
    expect(sent).toHaveLength(1);

    // And three more afterwards, when the queue no longer deduplicates a
    // completed job: the worker's lock and state check are what stop a second
    // send, not the queue.
    await recovery.execute();
    await recovery.execute();
    await recovery.execute();
    await queue.drain();
    expect(sent).toHaveLength(1);
  });

  it('re-enqueues an entitlement whose last attempt failed', async () => {
    const recommendationId = await approvedWithoutEnqueue(tenantA);
    // A committed failure: retryable, and still unfinished.
    await transactions.withTenant(orgA, (scope) =>
      intents.settle(scope, recommendationId, {
        state: 'failed',
        attempts: 1,
        lastError: 'SMTP_SEND_FAILED: the provider refused',
        updatedAt: systemClock.now(),
      }),
    );

    const report = await recovery.execute();
    expect(report).toMatchObject({ found: 1, requeued: 1 });
    expect(queuedFor(recommendationId)).toBe(1);
  });

  it('keeps two tenants apart: each is swept in its own scope', async () => {
    const first = await approvedWithoutEnqueue(tenantA);
    const second = await approvedWithoutEnqueue(tenantB);

    const report = await recovery.execute();
    expect(report).toMatchObject({ tenants: 2, found: 2, requeued: 2, failed: 0 });

    // Each job carries its own tenant, so the worker re-enters the right scope.
    const jobs = queue.jobs.filter((job) => job.name === executeRecommendationJob.name);
    expect(jobs).toHaveLength(2);
    const payloads = jobs.map(
      (job) => job.payload as { tenantId: string; recommendationId: string },
    );
    expect(payloads).toContainEqual({ tenantId: orgA, recommendationId: first });
    expect(payloads).toContainEqual({ tenantId: orgB, recommendationId: second });
    // Neither tenant's payload names the other's work.
    expect(payloads.find((p) => p.tenantId === orgA)?.recommendationId).not.toBe(second);

    await queue.drain();
    expect(sent).toHaveLength(2);
  });

  it('sees only its own tenant when the sweep is scoped to one', async () => {
    const mine = await approvedWithoutEnqueue(tenantA);
    await approvedWithoutEnqueue(tenantB);

    // The per-tenant read the sweep performs, on its own: row-level security
    // limits it to the tenant whose scope it runs in.
    const visible = await transactions.withTenant(orgA, (scope) =>
      intents.listUnfinished(scope, 50),
    );
    expect(visible.map((intent) => intent.recommendationId)).toEqual([mine]);
    expect(visible.every((intent) => intent.organizationId === orgA)).toBe(true);
  });

  it('is safe when two sweeps run at once', async () => {
    const recommendationId = await approvedWithoutEnqueue(tenantA);

    const [first, second] = await Promise.all([recovery.execute(), recovery.execute()]);
    expect(first.found + second.found).toBeGreaterThan(0);
    // One job, whichever sweep won the race.
    expect(queuedFor(recommendationId)).toBe(1);

    await queue.drain();
    expect(sent).toHaveLength(1);
  });

  it('leaves the work recoverable when the queue is unavailable, and recovers when it returns', async () => {
    const recommendationId = await approvedWithoutEnqueue(tenantA);

    queue.offline = true;
    const duringOutage = await recovery.execute();
    queue.offline = false;
    // The sweep found the work and could not hand it on. Nothing was lost.
    expect(duringOutage).toMatchObject({ found: 1, requeued: 0, failed: 1 });
    expect(queuedFor(recommendationId)).toBe(0);
    expect(await intentOf(tenantA, recommendationId)).toMatchObject({ state: 'pending' });

    const afterOutage = await recovery.execute();
    expect(afterOutage).toMatchObject({ found: 1, requeued: 1, failed: 0 });
    await queue.drain();
    expect(sent).toHaveLength(1);
    expect(await intentOf(tenantA, recommendationId)).toMatchObject({ state: 'sent' });
  });

  it('recovers after a restart, when nothing in memory remembers the work', async () => {
    const recommendationId = await approvedWithoutEnqueue(tenantA);
    // A restart: the queue is empty and no handler ever saw this job. All that
    // survives is the row the approval committed.
    queue.jobs.length = 0;

    const report = await recovery.execute();
    expect(report).toMatchObject({ found: 1, requeued: 1 });
    await queue.drain();
    expect(sent).toHaveLength(1);
    // Recovered work carries the identity the approval derived, so a message
    // sent after a restart is the same message, not a new one.
    const intent = await intentOf(tenantA, recommendationId);
    expect(sent[0]?.idempotencyKey).toBe(intent?.idempotencyKey);
  });

  it('stops sweeping work that has failed too many times', async () => {
    const recommendationId = await approvedWithoutEnqueue(tenantA);
    // Something about this one is broken in a way retrying will not fix — a
    // stale input hash, say. Without a bound, every sweep for ever would ask
    // for it again.
    await transactions.withTenant(orgA, (scope) =>
      intents.settle(scope, recommendationId, {
        state: 'failed',
        attempts: 10,
        lastError: 'STALE_EXECUTION_INTENT: what was authorised is not what this says',
        updatedAt: systemClock.now(),
      }),
    );

    const report = await recovery.execute();
    expect(report).toMatchObject({ found: 1, requeued: 0, exhausted: 1 });
    expect(queuedFor(recommendationId)).toBe(0);
    // It is not hidden: it stays in the table for a person to look at.
    const left = await intentOf(tenantA, recommendationId);
    expect(left).toMatchObject({ state: 'failed', attempts: 10 });
    expect(left?.lastError).toContain('STALE_EXECUTION_INTENT');
  });

  it('still sweeps work that has failed a few times', async () => {
    const recommendationId = await approvedWithoutEnqueue(tenantA);
    await transactions.withTenant(orgA, (scope) =>
      intents.settle(scope, recommendationId, {
        state: 'failed',
        attempts: 9,
        lastError: 'SMTP_SEND_FAILED: the provider refused',
        updatedAt: systemClock.now(),
      }),
    );

    const report = await recovery.execute();
    expect(report).toMatchObject({ found: 1, requeued: 1, exhausted: 0 });
    expect(queuedFor(recommendationId)).toBe(1);
  });

  it('creates no entitlement of its own', async () => {
    const before = await transactions.withTenant(orgA, (scope) =>
      intents.listUnfinished(scope, 100),
    );
    await recovery.execute();
    await recovery.execute();
    const after = await transactions.withTenant(orgA, (scope) =>
      intents.listUnfinished(scope, 100),
    );
    expect(after.map((intent) => intent.recommendationId).sort()).toEqual(
      before.map((intent) => intent.recommendationId).sort(),
    );
  });
});
