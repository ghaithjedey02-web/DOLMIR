import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ActorType,
  AuditTrail,
  EventLedger,
  type LedgerEvent,
  PostgresAuditLogRepository,
  PostgresLedgerRepository,
  PostgresMembershipRepository,
  PostgresOrganizationRepository,
  PostgresProjectionCheckpointRepository,
  PostgresTransactionRunner,
  PostgresUserRepository,
  type Projection,
  ProjectionRunner,
  ProvisionOrganization,
  type SystemScope,
  clientOf,
  noExecutionContext,
  noopLogger,
  systemClock,
  type OrganizationId,
} from '@dolmir/core';

import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

describe('event ledger and audit log on PostgreSQL', () => {
  let db: TestDatabase;
  let transactions: PostgresTransactionRunner;
  let orgA: OrganizationId;
  let orgB: OrganizationId;
  const ledgerRepository = new PostgresLedgerRepository();
  const checkpoints = new PostgresProjectionCheckpointRepository();
  const auditRepository = new PostgresAuditLogRepository();
  const ledger = new EventLedger({ repository: ledgerRepository, context: noExecutionContext });
  const audit = new AuditTrail({
    repository: auditRepository,
    clock: systemClock,
    context: noExecutionContext,
  });

  const received = (documentId: string, idempotencyKey?: string) => ({
    eventType: 'DocumentReceived',
    schemaVersion: 1,
    payload: { documentId },
    provenance: {
      sourceKind: 'EMAIL' as const,
      sourceRef: `msg:${documentId}`,
      actor: { type: ActorType.SYSTEM, id: 'n8n-ingest' },
      recordedBy: 'intake.ingest',
    },
    occurredAt: new Date('2026-09-02T09:00:00.000Z'),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    transactions = new PostgresTransactionRunner(db.appPool, noopLogger);
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
  });

  afterAll(async () => {
    await db.drop();
  });

  it('appends with exact versions, reads back in order, and detects a stale version', async () => {
    const stream = { type: 'document', id: 'DOC-1' };
    await transactions.withTenant(orgA, async (scope) => {
      const first = await ledger.append(scope, stream, [received('DOC-1')], 'none');
      expect(first.ok).toBe(true);
      const second = await ledger.append(
        scope,
        stream,
        [{ ...received('DOC-1'), eventType: 'DocumentClassified' }],
        1,
      );
      expect(second.ok).toBe(true);
      const stale = await ledger.append(scope, stream, [received('DOC-1')], 1);
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toBe('STREAM_VERSION_CONFLICT');
      const events = await ledger.readStream(scope, stream);
      expect(events.map((e) => [e.streamSequence, e.eventType])).toEqual([
        [1, 'DocumentReceived'],
        [2, 'DocumentClassified'],
      ]);
      expect(events[1]?.globalSequence).toBeGreaterThan(events[0]?.globalSequence ?? 0);
    });
  });

  it('serialises concurrent appenders: exactly one wins the same expected version', async () => {
    const stream = { type: 'document', id: 'RACE' };
    const attempt = () =>
      transactions.withTenant(orgA, (scope) =>
        ledger.append(scope, stream, [received('RACE')], 'none'),
      );
    const outcomes = await Promise.all([attempt(), attempt(), attempt()]);
    const wins = outcomes.filter((o) => o.ok).length;
    const conflicts = outcomes.filter(
      (o) => !o.ok && o.error.code === 'STREAM_VERSION_CONFLICT',
    ).length;
    expect(wins).toBe(1);
    expect(conflicts).toBe(2);
    await transactions.withTenant(orgA, async (scope) => {
      expect(await ledger.readStream(scope, stream)).toHaveLength(1);
    });
  });

  it('replays idempotent appends and refuses partial reuse', async () => {
    const stream = { type: 'document', id: 'IDEM' };
    await transactions.withTenant(orgA, async (scope) => {
      const first = await ledger.append(scope, stream, [received('IDEM', 'delivery-1')], 'any');
      const replay = await ledger.append(scope, stream, [received('IDEM', 'delivery-1')], 'any');
      expect(first.ok && replay.ok).toBe(true);
      if (first.ok && replay.ok) expect(replay.value[0]?.id).toBe(first.value[0]?.id);
      const partial = await ledger.append(
        scope,
        stream,
        [received('IDEM', 'delivery-1'), received('IDEM', 'delivery-2')],
        'any',
      );
      expect(partial.ok).toBe(false);
      if (!partial.ok) expect(partial.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await ledger.readStream(scope, stream)).toHaveLength(1);
    });
  });

  it('is append-only for the runtime role and for the owner alike', async () => {
    await expect(
      transactions.withTenant(orgA, async (scope) => {
        await clientOf(scope).query("UPDATE public.ledger_events SET payload = '{}'::jsonb");
      }),
    ).rejects.toMatchObject({ category: 'forbidden' });
    await expect(
      transactions.withTenant(orgA, async (scope) => {
        await clientOf(scope).query('DELETE FROM public.ledger_events');
      }),
    ).rejects.toMatchObject({ category: 'forbidden' });
    // The owner has the privilege, and in system scope it can see the rows —
    // the trigger still refuses. (Outside any scope forced RLS hides every row,
    // so a DELETE would match nothing: isolation and immutability are separate guards.)
    const ownerInSystemScope = async (sql: string): Promise<string | undefined> => {
      const client = await db.ownerPool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('dolmir.scope', 'system', true)");
        try {
          await client.query(sql);
          return undefined;
        } catch (error) {
          return (error as { code?: string }).code;
        } finally {
          await client.query('ROLLBACK');
        }
      } finally {
        client.release();
      }
    };
    expect(await ownerInSystemScope('DELETE FROM public.ledger_events')).toBe('23000');
    expect(await ownerInSystemScope("UPDATE public.ledger_events SET payload = '{}'::jsonb")).toBe(
      '23000',
    );
    expect(await ownerInSystemScope('DELETE FROM public.audit_log')).toBe('23000');
  });

  it('isolates tenants and lets a system-scope projection consume every tenant in order', async () => {
    await transactions.withTenant(orgB, async (scope) => {
      await ledger.append(scope, { type: 'document', id: 'B-1' }, [received('B-1')], 'none');
      const foreign = await ledger.readStream(scope, { type: 'document', id: 'DOC-1' });
      expect(foreign).toEqual([]);
    });

    const seen: { org: OrganizationId; seq: number }[] = [];
    const projection: Projection = {
      name: 'test_seen',
      apply: async (_scope: SystemScope, event: LedgerEvent) => {
        seen.push({ org: event.organizationId, seq: event.globalSequence });
      },
      reset: async () => {
        seen.length = 0;
      },
    };
    const runner = new ProjectionRunner({
      transactions,
      ledger: ledgerRepository,
      checkpoints,
      batchSize: 2,
    });
    const report = await runner.runOnce(projection);
    expect(report.processed).toBeGreaterThanOrEqual(4);
    expect(seen.map((s) => s.seq)).toEqual([...seen.map((s) => s.seq)].sort((x, y) => x - y));
    expect(new Set(seen.map((s) => s.org))).toEqual(new Set([orgA, orgB]));
    expect((await runner.runOnce(projection)).processed).toBe(0);
    const checkpoint = await db.appPool.query(
      "SELECT last_global_sequence::int AS n FROM public.projection_checkpoints WHERE projection_name = 'test_seen'",
    );
    expect(checkpoint.rows[0]).toEqual({ n: report.lastGlobalSequence });
  });

  it('records audit entries per tenant, including the provisioning trail, and hides other tenants', async () => {
    await transactions.withTenant(orgA, async (scope) => {
      await audit.record(scope, {
        organizationId: orgA,
        actor: { type: ActorType.USER, id: 'u-a' },
        action: 'document.reviewed',
        target: { type: 'document', id: 'DOC-1' },
        details: { note: 'ok', token: 'should-vanish' },
      });
      const entries = await audit.list(scope, { limit: 10 });
      expect(entries.map((e) => e.action)).toEqual([
        'document.reviewed',
        'organization.provisioned',
      ]);
      expect(entries[0]?.details).toEqual({ note: 'ok', token: '[REDACTED]' });
    });
    await transactions.withTenant(orgB, async (scope) => {
      const entries = await audit.list(scope, { limit: 10 });
      expect(entries.map((e) => e.action)).toEqual(['organization.provisioned']);
      expect(entries[0]?.organizationId).toBe(orgB);
    });
  });
});
