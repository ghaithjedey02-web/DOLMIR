import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  type ActionIntent,
  AuditTrail,
  type CaseDraftInput,
  CaseEngine,
  CaseProjection,
  EventLedger,
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
  type Scope,
  type TenantContext,
  type TenantScope,
  ToolEffect,
  ToolExecutor,
  ToolRegistry,
  authorizer,
  clientOf,
  defineTool,
  err,
  noExecutionContext,
  noopLogger,
  ok,
  systemClock,
} from '@dolmir/core';
import { InfrastructureError } from '@dolmir/core';

import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

/**
 * Durable, concurrency-safe, idempotent execution — on the database that has
 * to provide it.
 *
 * None of these invariants can be proved in memory. Exclusion between two
 * workers is `SELECT … FOR UPDATE` blocking a second transaction; surviving a
 * crash is a transaction rolling back; isolation between tenants is row-level
 * security refusing to show a row. Each test below drives the real engine
 * against real PostgreSQL and asserts what the outside world saw.
 */

/** Everything an attempt sent, in order, with the identity it carried. */
const sent: { to: string; idempotencyKey: string | undefined }[] = [];
let failNextSend: InfrastructureError | undefined;

const sendReply = defineTool({
  name: 'send_reply',
  description: 'Send an approved reply to the customer.',
  effect: ToolEffect.ACT,
  permission: Permission.AI_INVOKE,
  input: z.object({ to: z.email(), body: z.string().min(1) }),
  output: z.object({ messageId: z.string() }),
  handler: async (input, context) => {
    if (failNextSend !== undefined) {
      const failure = failNextSend;
      failNextSend = undefined;
      return err(failure);
    }
    sent.push({ to: input.to, idempotencyKey: context.idempotencyKey });
    return ok({ messageId: `msg-${String(sent.length)}` });
  },
});

/**
 * An entitlement store that can lose the transaction after the tool has
 * already acted — the one window the design cannot close, made reproducible.
 */
class CrashingIntents extends PostgresActionIntentRepository {
  crashOnNextSettle = false;

  override async settle(
    scope: Scope,
    recommendationId: string,
    patch: Parameters<PostgresActionIntentRepository['settle']>[2],
  ): Promise<void> {
    if (this.crashOnNextSettle) {
      this.crashOnNextSettle = false;
      throw new InfrastructureError('SIMULATED_CRASH', 'The process died before committing.');
    }
    return super.settle(scope, recommendationId, patch);
  }
}

describe('durable execution of approved recommendations', () => {
  let db: TestDatabase;
  let transactions: PostgresTransactionRunner;
  let engine: CaseEngine;
  let orgA: OrganizationId;
  let orgB: OrganizationId;
  let tenantA: TenantContext;
  let tenantB: TenantContext;
  const cases = new PostgresCaseRepository();
  const intents = new CrashingIntents();

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

  /** Opens a case and approves its only recommendation, as a person would. */
  async function approved(tenant: TenantContext = tenantA): Promise<string> {
    const opened = await engine.openCase(tenant.organizationId, draft, {
      systemKey: 'test_inbox',
      systemVersion: 1,
      sourceRef: `document:${crypto.randomUUID()}`,
    });
    if (!opened.ok) throw opened.error;
    const recommendationId = opened.value.recommendations[0]?.id;
    if (recommendationId === undefined) throw new Error('no recommendation');
    const decided = await engine.decide(tenant, recommendationId, 'approved', 'Va bene.');
    if (!decided.ok) throw decided.error;
    return recommendationId;
  }

  const intentOf = async (
    tenant: TenantContext,
    recommendationId: string,
  ): Promise<ActionIntent | undefined> =>
    transactions.withTenant(tenant.organizationId, (scope: TenantScope) =>
      intents.find(scope, recommendationId),
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    transactions = new PostgresTransactionRunner(db.appPool, noopLogger);
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
    });
  });

  afterEach(() => {
    sent.length = 0;
    failNextSend = undefined;
    intents.crashOnNextSettle = false;
  });

  afterAll(async () => {
    await db.drop();
  });

  it('records a durable entitlement in the transaction that approves, before anything runs', async () => {
    const recommendationId = await approved();
    const intent = await intentOf(tenantA, recommendationId);
    expect(intent).toMatchObject({
      organizationId: orgA,
      recommendationId,
      tool: 'send_reply',
      state: 'pending',
      attempts: 0,
      externalRef: null,
    });
    // Derived from what was approved, so every attempt carries one identity.
    expect(intent?.idempotencyKey).toBe(`${recommendationId}.${intent?.inputHash.slice(0, 16)}`);
    // The approval alone sends nothing: the work is handed to a worker.
    expect(sent).toHaveLength(0);
  });

  it('executes once, and a worker that runs again afterwards sends nothing', async () => {
    const recommendationId = await approved();

    const first = await engine.execute(orgA, recommendationId);
    expect(first.ok && first.value.status).toBe('succeeded');
    expect(sent).toHaveLength(1);

    // The queue redelivered the job — after a lost acknowledgement, say.
    const again = await engine.execute(orgA, recommendationId);
    expect(again.ok).toBe(true);
    expect(again.ok ? again.value.id : null).toBe(first.ok ? first.value.id : undefined);
    expect(sent).toHaveLength(1);

    const intent = await intentOf(tenantA, recommendationId);
    expect(intent).toMatchObject({ state: 'sent', attempts: 1, externalRef: 'msg-1' });
  });

  it('lets only one of two concurrent workers act', async () => {
    const recommendationId = await approved();

    // Two workers, two connections, one row. The second blocks in PostgreSQL
    // until the first commits, then finds the work already done.
    const [first, second] = await Promise.all([
      engine.execute(orgA, recommendationId),
      engine.execute(orgA, recommendationId),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(sent).toHaveLength(1);
    // Both saw the same action: one execution, reported twice.
    expect(first.ok ? first.value.id : null).toBe(second.ok ? second.value.id : undefined);
    const intent = await intentOf(tenantA, recommendationId);
    expect(intent).toMatchObject({ state: 'sent', attempts: 1 });
  });

  it('keeps a failed attempt retryable, and a retry sends exactly once more', async () => {
    const recommendationId = await approved();
    failNextSend = new InfrastructureError('SMTP_SEND_FAILED', 'The message could not be sent.', {
      retryable: true,
    });

    const failed = await engine.execute(orgA, recommendationId);
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.error.code).toBe('ACTION_FAILED');
    expect(sent).toHaveLength(0);

    const afterFailure = await intentOf(tenantA, recommendationId);
    expect(afterFailure).toMatchObject({ state: 'failed', attempts: 1 });
    expect(afterFailure?.lastError).toContain('SMTP_SEND_FAILED');

    const retried = await engine.execute(orgA, recommendationId);
    if (!retried.ok) throw new Error(`${retried.error.code}: ${retried.error.message}`);
    expect(retried.value.status).toBe('succeeded');
    expect(sent).toHaveLength(1);

    const settled = await intentOf(tenantA, recommendationId);
    expect(settled).toMatchObject({ state: 'sent', attempts: 2 });

    // The case records both attempts: the failure is not erased by the success.
    const actions = await transactions.withTenant(orgA, (scope) =>
      cases.listActions(scope, retried.value.caseId),
    );
    expect(actions.map((action) => action.status).sort()).toEqual(['failed', 'succeeded']);
  });

  it('carries one identity across every attempt at the same authorised action', async () => {
    const recommendationId = await approved();
    const intent = await intentOf(tenantA, recommendationId);

    failNextSend = new InfrastructureError('SMTP_SEND_FAILED', 'nope', { retryable: true });
    await engine.execute(orgA, recommendationId);
    await engine.execute(orgA, recommendationId);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.idempotencyKey).toBe(intent?.idempotencyKey);
  });

  it('a crash between the send and the commit costs a duplicate, not a second identity', async () => {
    // The one window that cannot be closed: the provider accepted the message
    // and the transaction then died, so the outcome was never recorded. The
    // retry is indistinguishable from a first attempt — except that it carries
    // the same identity, which is the whole of what can be guaranteed here.
    const recommendationId = await approved();
    intents.crashOnNextSettle = true;

    await expect(engine.execute(orgA, recommendationId)).rejects.toThrow();
    expect(sent).toHaveLength(1);
    // The transaction rolled back, so the entitlement is untouched and pending.
    expect(await intentOf(tenantA, recommendationId)).toMatchObject({
      state: 'pending',
      attempts: 0,
    });

    const retried = await engine.execute(orgA, recommendationId);
    expect(retried.ok && retried.value.status).toBe('succeeded');

    // Two messages left the building. Both are the same message: one identity,
    // which a conforming client collapses. Exactly-once delivery across SMTP
    // and PostgreSQL is not achievable, and DOLMIR does not claim it.
    expect(sent).toHaveLength(2);
    expect(sent[0]?.idempotencyKey).toBe(sent[1]?.idempotencyKey);
    // Exactly one outcome is persisted, whatever the provider saw.
    expect(await intentOf(tenantA, recommendationId)).toMatchObject({
      state: 'sent',
      attempts: 1,
    });
  });

  it('refuses an attempt from another tenant, and shows it nothing', async () => {
    const recommendationId = await approved(tenantA);

    const stolen = await engine.execute(orgB, recommendationId);
    expect(stolen.ok).toBe(false);
    // Row-level security hides the entitlement, so the answer is the same one a
    // caller gets for work that never existed.
    expect(!stolen.ok && stolen.error.code).toBe('NO_EXECUTION_INTENT');
    expect(sent).toHaveLength(0);
    expect(await intentOf(tenantB, recommendationId)).toBeUndefined();
    expect(await intentOf(tenantA, recommendationId)).toMatchObject({ state: 'pending' });
  });

  it('refuses to act when nothing authorised it', async () => {
    const opened = await engine.openCase(orgA, draft, {
      systemKey: 'test_inbox',
      systemVersion: 1,
      sourceRef: 'document:unapproved',
    });
    if (!opened.ok) throw opened.error;
    const recommendationId = opened.value.recommendations[0]?.id ?? '';

    const refused = await engine.execute(orgA, recommendationId);
    expect(!refused.ok && refused.error.code).toBe('NO_EXECUTION_INTENT');
    expect(sent).toHaveLength(0);
  });

  it('refuses an attempt on an input that is not the one approved', async () => {
    const recommendationId = await approved();
    // The recommendation drifts away from what the human saw. Whatever caused
    // it, the entitlement covers the old input and not this one.
    await transactions.withTenant(orgA, async (scope) => {
      await clientOf(scope).query(
        `UPDATE public.recommendations SET input_hash = $2 WHERE id = $1`,
        [recommendationId, 'f'.repeat(64)],
      );
    });

    const refused = await engine.execute(orgA, recommendationId);
    expect(!refused.ok && refused.error.code).toBe('STALE_EXECUTION_INTENT');
    expect(sent).toHaveLength(0);
    // Recorded rather than left looking runnable, so it stops asking to be retried.
    expect(await intentOf(tenantA, recommendationId)).toMatchObject({ state: 'failed' });
  });
});
