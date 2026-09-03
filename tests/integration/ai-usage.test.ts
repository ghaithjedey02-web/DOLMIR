import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AiUsageTracker,
  AuditTrail,
  CostBook,
  FakeLlmProvider,
  LlmError,
  type LlmRequest,
  type OrganizationId,
  PostgresAiUsageRepository,
  PostgresAuditLogRepository,
  PostgresMembershipRepository,
  PostgresOrganizationRepository,
  PostgresTransactionRunner,
  PostgresUserRepository,
  ProvisionOrganization,
  RecordedLlmProvider,
  ZERO_USAGE,
  clientOf,
  noExecutionContext,
  noopLogger,
  systemClock,
} from '@dolmir/core';

import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

describe('AI usage on PostgreSQL', () => {
  let db: TestDatabase;
  let transactions: PostgresTransactionRunner;
  let orgA: OrganizationId;
  let orgB: OrganizationId;
  const repository = new PostgresAiUsageRepository();
  const fake = new FakeLlmProvider();
  const costBook = new CostBook({
    version: 3,
    prices: {
      'fake-fast': {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 5,
        cacheReadMultiplier: 0.1,
        cacheWriteMultiplier: 1.25,
      },
    },
  });
  let provider: RecordedLlmProvider;
  let tracker: AiUsageTracker;

  const requestFor = (tenantId: OrganizationId | null): LlmRequest => ({
    tenantId,
    tier: 'fast',
    operation: 'classify_message',
    useCase: 'commercial_inbox',
    messages: [{ role: 'user', content: 'Preventivo per 250 flange tornite.' }],
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    transactions = new PostgresTransactionRunner(db.appPool, noopLogger);
    const audit = new AuditTrail({
      repository: new PostgresAuditLogRepository(),
      clock: systemClock,
      context: noExecutionContext,
    });
    const provision = new ProvisionOrganization({
      transactions,
      organizations: new PostgresOrganizationRepository(),
      users: new PostgresUserRepository(),
      memberships: new PostgresMembershipRepository(),
      audit,
    });
    const a = await provision.execute({
      organization: { slug: 'a', name: 'A' },
      owner: { authSubject: 'auth|a' },
    });
    const b = await provision.execute({
      organization: { slug: 'b', name: 'B' },
      owner: { authSubject: 'auth|b' },
    });
    if (!a.ok || !b.ok) throw new Error('provisioning failed');
    orgA = a.value.organization.id;
    orgB = b.value.organization.id;
    tracker = new AiUsageTracker({
      repository,
      transactions,
      clock: systemClock,
      context: noExecutionContext,
    });
    provider = new RecordedLlmProvider({ inner: fake, usage: tracker, costBook });
  });

  afterAll(async () => {
    await db.drop();
  });

  it('records a priced row per call, visible only inside the tenant that made it', async () => {
    fake.enqueue({ text: 'rdo', usage: { inputTokens: 1000, outputTokens: 200 } });
    const result = await provider.complete(requestFor(orgA));
    expect(result.ok).toBe(true);

    const seenByA = await transactions.withTenant(orgA, (scope) =>
      tracker.list(scope, { limit: 10 }),
    );
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]).toMatchObject({
      organizationId: orgA,
      provider: 'fake',
      model: 'fake-fast',
      tier: 'fast',
      operation: 'classify_message',
      useCase: 'commercial_inbox',
      inputTokens: 1000,
      outputTokens: 200,
      estimatedCost: 0.002,
      currency: 'USD',
      pricingVersion: 3,
      priced: true,
      succeeded: true,
      errorKind: null,
      cached: false,
    });
    const seenByB = await transactions.withTenant(orgB, (scope) =>
      tracker.list(scope, { limit: 10 }),
    );
    expect(seenByB).toEqual([]);
  });

  it('records failed calls and aggregates per use case and model', async () => {
    fake.enqueue({
      error: new LlmError('BAD_RESPONSE', 'bad', {
        attempt: {
          model: 'fake-fast',
          usage: { ...ZERO_USAGE, inputTokens: 500, outputTokens: 20 },
          latencyMs: 8,
          providerRequestId: undefined,
        },
      }),
    });
    const failed = await provider.complete(requestFor(orgA));
    expect(failed.ok).toBe(false);

    const summary = await transactions.withTenant(orgA, (scope) => tracker.summarize(scope, {}));
    expect(summary).toEqual([
      {
        useCase: 'commercial_inbox',
        model: 'fake-fast',
        calls: 2,
        inputTokens: 1500,
        outputTokens: 220,
        estimatedCost: 0.0026,
        currency: 'USD',
        unpricedCalls: 0,
      },
    ]);
    const failures = await transactions.withTenant(orgA, (scope) =>
      tracker.list(scope, { limit: 10 }),
    );
    expect(failures.some((r) => !r.succeeded && r.errorKind === 'BAD_RESPONSE')).toBe(true);
  });

  it('stores tenant-less platform calls in system scope, invisible to tenants', async () => {
    fake.enqueue({ text: 'diagnostic ok' });
    const result = await provider.complete(requestFor(null));
    expect(result.ok).toBe(true);

    const seenByA = await transactions.withTenant(orgA, (scope) =>
      clientOf(scope).query(
        'SELECT count(*)::int AS n FROM public.ai_usage WHERE organization_id IS NULL',
      ),
    );
    expect(seenByA.rows[0]).toEqual({ n: 0 });

    const seenBySystem = await transactions.withSystemScope('test: count platform rows', (scope) =>
      clientOf(scope).query(
        'SELECT count(*)::int AS n FROM public.ai_usage WHERE organization_id IS NULL',
      ),
    );
    expect(seenBySystem.rows[0]).toEqual({ n: 1 });
  });

  it('is append-only for the runtime role and for the owner alike', async () => {
    await expect(
      transactions.withTenant(orgA, (scope) =>
        clientOf(scope).query('UPDATE public.ai_usage SET estimated_cost = 0'),
      ),
    ).rejects.toMatchObject({ category: 'forbidden' });
    await expect(
      transactions.withTenant(orgA, (scope) =>
        clientOf(scope).query('DELETE FROM public.ai_usage'),
      ),
    ).rejects.toMatchObject({ category: 'forbidden' });

    const owner = await db.ownerPool.connect();
    try {
      await owner.query('BEGIN');
      await owner.query("SELECT set_config('dolmir.scope', 'system', true)");
      await expect(owner.query('DELETE FROM public.ai_usage')).rejects.toMatchObject({
        code: '23000',
      });
      await owner.query('ROLLBACK');
    } finally {
      owner.release();
    }
  });
});
