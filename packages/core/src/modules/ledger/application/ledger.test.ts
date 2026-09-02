import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../../kernel/clock.js';
import { ActorType, noExecutionContext } from '../../../kernel/context.js';
import { newOrganizationId } from '../../../kernel/ids.js';
import type { SystemScope, TenantScope } from '../../../kernel/scope.js';
import {
  InMemoryLedgerRepository,
  InMemoryProjectionCheckpointRepository,
} from '../adapters/memory/in-memory-ledger-repository.js';
import type { LedgerEvent, NewLedgerEventInput } from '../domain/ledger-event.js';
import { EventLedger } from './event-ledger.js';
import { type Projection, ProjectionRunner } from './projection-runner.js';

const clock = new FixedClock(new Date('2026-09-02T12:00:00.000Z'));
const tenantA = newOrganizationId();
const tenantB = newOrganizationId();
const scopeA: TenantScope = { kind: 'tenant', tenantId: tenantA };
const scopeB: TenantScope = { kind: 'tenant', tenantId: tenantB };

const received = (
  documentId: string,
  extra: Partial<NewLedgerEventInput> = {},
): NewLedgerEventInput => ({
  eventType: 'DocumentReceived',
  schemaVersion: 1,
  payload: { documentId, channel: 'email' },
  provenance: {
    sourceKind: 'EMAIL',
    sourceRef: `msg:${documentId}`,
    actor: { type: ActorType.SYSTEM, id: 'n8n-ingest' },
    recordedBy: 'intake.ingest',
  },
  occurredAt: clock.now(),
  ...extra,
});

describe('EventLedger', () => {
  it('appends with exact expected versions and reads the stream back in order', async () => {
    const repository = new InMemoryLedgerRepository(clock);
    const ledger = new EventLedger({ repository, context: noExecutionContext });
    const stream = { type: 'document', id: 'DOC-1' };

    const first = await ledger.append(scopeA, stream, [received('DOC-1')], 'none');
    expect(first.ok).toBe(true);
    const second = await ledger.append(
      scopeA,
      stream,
      [{ ...received('DOC-1'), eventType: 'DocumentClassified', payload: { label: 'RFQ' } }],
      1,
    );
    expect(second.ok).toBe(true);

    const events = await ledger.readStream(scopeA, stream);
    expect(events.map((e) => [e.streamSequence, e.eventType])).toEqual([
      [1, 'DocumentReceived'],
      [2, 'DocumentClassified'],
    ]);
    expect(events[0]?.provenance.recordedBy).toBe('intake.ingest');
  });

  it('refuses a stale expected version and a duplicate "none"', async () => {
    const repository = new InMemoryLedgerRepository(clock);
    const ledger = new EventLedger({ repository, context: noExecutionContext });
    const stream = { type: 'document', id: 'DOC-2' };
    await ledger.append(scopeA, stream, [received('DOC-2')], 'none');

    const stale = await ledger.append(scopeA, stream, [received('DOC-2')], 0);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('STREAM_VERSION_CONFLICT');
      expect(stale.error.details).toMatchObject({ expected: 0, actual: 1 });
    }
    const duplicateStart = await ledger.append(scopeA, stream, [received('DOC-2')], 'none');
    expect(duplicateStart.ok).toBe(false);
    const any = await ledger.append(scopeA, stream, [received('DOC-2')], 'any');
    expect(any.ok).toBe(true);
  });

  it('replays an idempotent append instead of duplicating it', async () => {
    const repository = new InMemoryLedgerRepository(clock);
    const ledger = new EventLedger({ repository, context: noExecutionContext });
    const stream = { type: 'document', id: 'DOC-3' };
    const event = received('DOC-3', { idempotencyKey: 'webhook-delivery-42' });
    const first = await ledger.append(scopeA, stream, [event], 'any');
    const replay = await ledger.append(scopeA, stream, [event], 'any');
    expect(first.ok && replay.ok).toBe(true);
    if (first.ok && replay.ok) expect(replay.value[0]?.id).toBe(first.value[0]?.id);
    expect(await ledger.readStream(scopeA, stream)).toHaveLength(1);
  });

  it('rejects events without provenance or with malformed names, as values', async () => {
    const repository = new InMemoryLedgerRepository(clock);
    const ledger = new EventLedger({ repository, context: noExecutionContext });
    const noProvenance = await ledger.append(
      scopeA,
      { type: 'document', id: 'x' },
      [{ eventType: 'Thing', schemaVersion: 1, payload: {}, occurredAt: clock.now() } as never],
      'any',
    );
    expect(noProvenance.ok).toBe(false);
    if (!noProvenance.ok) expect(noProvenance.error.code).toBe('INVALID_LEDGER_EVENT');

    const badStream = await ledger.append(
      scopeA,
      { type: 'Document Stream', id: 'x' },
      [received('x')],
      'any',
    );
    expect(badStream.ok).toBe(false);
    if (!badStream.ok) expect(badStream.error.code).toBe('INVALID_STREAM');

    const badName = await ledger.append(
      scopeA,
      { type: 'document', id: 'x' },
      [received('x', { eventType: 'received' })],
      'any',
    );
    expect(badName.ok).toBe(false);
    expect(repository.events).toHaveLength(0);
  });

  it('keeps tenants apart', async () => {
    const repository = new InMemoryLedgerRepository(clock);
    const ledger = new EventLedger({ repository, context: noExecutionContext });
    const stream = { type: 'document', id: 'SHARED-ID' };
    await ledger.append(scopeA, stream, [received('a')], 'none');
    await ledger.append(scopeB, stream, [received('b')], 'none');
    expect((await ledger.readStream(scopeA, stream)).map((e) => e.payload['documentId'])).toEqual([
      'a',
    ]);
    expect((await ledger.readStream(scopeB, stream)).map((e) => e.payload['documentId'])).toEqual([
      'b',
    ]);
  });
});

describe('ProjectionRunner', () => {
  class CountByType implements Projection {
    readonly name = 'count_by_type';
    readonly counts = new Map<string, number>();
    readonly applied: number[] = [];

    async apply(_scope: SystemScope, event: LedgerEvent): Promise<void> {
      this.counts.set(event.eventType, (this.counts.get(event.eventType) ?? 0) + 1);
      this.applied.push(event.globalSequence);
    }

    async reset(): Promise<void> {
      this.counts.clear();
      this.applied.length = 0;
    }
  }

  const transactions = {
    withTenant: async <T>(tenantId: typeof tenantA, fn: (s: TenantScope) => Promise<T>) =>
      fn({ kind: 'tenant', tenantId }),
    withSystemScope: async <T>(reason: string, fn: (s: SystemScope) => Promise<T>) =>
      fn({ kind: 'system', reason }),
  };

  it('applies events in global order across tenants, in batches, and checkpoints', async () => {
    const repository = new InMemoryLedgerRepository(clock);
    const checkpoints = new InMemoryProjectionCheckpointRepository();
    const ledger = new EventLedger({ repository, context: noExecutionContext });
    for (let i = 0; i < 5; i += 1) {
      await ledger.append(
        i % 2 === 0 ? scopeA : scopeB,
        { type: 'document', id: `D${i}` },
        [received(`D${i}`)],
        'none',
      );
    }
    const runner = new ProjectionRunner({
      transactions,
      ledger: repository,
      checkpoints,
      batchSize: 2,
    });
    const projection = new CountByType();

    const report = await runner.runOnce(projection);
    expect(report).toEqual({ processed: 5, lastGlobalSequence: 5 });
    expect(projection.applied).toEqual([1, 2, 3, 4, 5]);
    expect(projection.counts.get('DocumentReceived')).toBe(5);
    expect(await checkpoints.get({ kind: 'system', reason: 't' }, 'count_by_type')).toBe(5);

    const again = await runner.runOnce(projection);
    expect(again.processed).toBe(0);

    await ledger.append(scopeA, { type: 'document', id: 'D9' }, [received('D9')], 'none');
    expect((await runner.runOnce(projection)).processed).toBe(1);
  });

  it('rebuilds from the first event after a reset', async () => {
    const repository = new InMemoryLedgerRepository(clock);
    const checkpoints = new InMemoryProjectionCheckpointRepository();
    const ledger = new EventLedger({ repository, context: noExecutionContext });
    await ledger.append(
      scopeA,
      { type: 'document', id: 'R1' },
      [received('R1'), received('R1')],
      'none',
    );
    const runner = new ProjectionRunner({ transactions, ledger: repository, checkpoints });
    const projection = new CountByType();
    await runner.runOnce(projection);
    const rebuilt = await runner.rebuild(projection);
    expect(rebuilt.processed).toBe(2);
    expect(projection.applied).toEqual([1, 2]);
  });
});
