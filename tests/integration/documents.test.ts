import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ActorType,
  AuditTrail,
  EventLedger,
  IngestDocument,
  InMemoryObjectStorage,
  type OrganizationId,
  PostgresAuditLogRepository,
  PostgresDocumentRepository,
  PostgresDocumentTextRepository,
  PostgresLedgerRepository,
  PostgresMembershipRepository,
  PostgresOrganizationRepository,
  PostgresTransactionRunner,
  PostgresUserRepository,
  ProvisionOrganization,
  clientOf,
  defaultTextExtractor,
  noExecutionContext,
  noopLogger,
  systemClock,
} from '@dolmir/core';

import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

describe('documents on PostgreSQL', () => {
  let db: TestDatabase;
  let transactions: PostgresTransactionRunner;
  let orgA: OrganizationId;
  let orgB: OrganizationId;
  const documents = new PostgresDocumentRepository();
  const texts = new PostgresDocumentTextRepository();
  let ingest: IngestDocument;
  const actor = { type: ActorType.SERVICE, id: 'test-ingest' };
  const body = new TextEncoder().encode('<p>Richiesta di <b>preventivo</b> per 250 flange</p>');

  beforeAll(async () => {
    db = await createTestDatabase();
    transactions = new PostgresTransactionRunner(db.appPool, noopLogger);
    const provision = new ProvisionOrganization({
      transactions,
      organizations: new PostgresOrganizationRepository(),
      users: new PostgresUserRepository(),
      memberships: new PostgresMembershipRepository(),
      audit: new AuditTrail({
        repository: new PostgresAuditLogRepository(),
        clock: systemClock,
        context: noExecutionContext,
      }),
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
    ingest = new IngestDocument({
      transactions,
      documents,
      texts,
      storage: new InMemoryObjectStorage(),
      extractor: defaultTextExtractor(),
      ledger: new EventLedger({
        repository: new PostgresLedgerRepository(),
        context: noExecutionContext,
      }),
      clock: systemClock,
    });
  });

  afterAll(async () => {
    await db.drop();
  });

  it('ingests a document with its text and event, visible only to its tenant', async () => {
    const result = await ingest.execute({
      tenantId: orgA,
      kind: 'email',
      sourceKind: 'EMAIL',
      sourceRef: 'ingest:<m1@cliente.test>',
      externalId: '<m1@cliente.test>',
      body,
      contentType: 'text/html; charset=utf-8',
      receivedAt: new Date('2026-09-02T09:00:00.000Z'),
      metadata: { subject: 'Preventivo flange' },
      actor,
      recordedBy: 'test',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const id = result.value.document.id;

    const seenByA = await transactions.withTenant(orgA, async (scope) => ({
      document: await documents.findById(scope, id),
      texts: await texts.listByDocument(scope, id),
      listed: await documents.list(scope, { limit: 10, topLevelOnly: true }),
    }));
    expect(seenByA.document?.textStatus).toBe('extracted');
    expect(seenByA.texts[0]?.text).toBe('Richiesta di preventivo per 250 flange');
    expect(seenByA.listed.map((d) => d.id)).toEqual([id]);

    const seenByB = await transactions.withTenant(orgB, async (scope) => ({
      document: await documents.findById(scope, id),
      texts: await texts.listByDocument(scope, id),
      bySource: await documents.findBySourceRef(scope, 'ingest:<m1@cliente.test>'),
    }));
    expect(seenByB).toEqual({ document: undefined, texts: [], bySource: undefined });

    const events = await transactions.withTenant(orgA, (scope) =>
      clientOf(scope).query(
        'SELECT event_type, stream_type, stream_id FROM public.ledger_events WHERE stream_id = $1',
        [id],
      ),
    );
    expect(events.rows).toEqual([
      { event_type: 'DocumentReceived', stream_type: 'document', stream_id: id },
    ]);
  });

  it('keeps ingestion idempotent per tenant and lets another tenant reuse a source reference', async () => {
    const input = {
      tenantId: orgA,
      kind: 'file' as const,
      sourceKind: 'USER' as const,
      sourceRef: 'upload:listino-2026',
      body,
      contentType: 'text/html',
      receivedAt: new Date(),
      actor,
      recordedBy: 'test',
    };
    const first = await ingest.execute(input);
    const again = await ingest.execute(input);
    expect(first.ok && again.ok && again.value.duplicate).toBe(true);
    const otherTenant = await ingest.execute({ ...input, tenantId: orgB });
    expect(otherTenant.ok && !otherTenant.value.duplicate).toBe(true);
  });

  it('lets the runtime role change only the text status and never delete', async () => {
    const result = await ingest.execute({
      tenantId: orgA,
      kind: 'email',
      sourceKind: 'EMAIL',
      sourceRef: 'imap:acquisti:7',
      body,
      contentType: 'text/html',
      receivedAt: new Date(),
      actor,
      recordedBy: 'test',
    });
    if (!result.ok) throw result.error;
    const id = result.value.document.id;
    await transactions.withTenant(orgA, (scope) => documents.setTextStatus(scope, id, 'failed'));
    const updated = await transactions.withTenant(orgA, (scope) => documents.findById(scope, id));
    expect(updated?.textStatus).toBe('failed');

    await expect(
      transactions.withTenant(orgA, (scope) =>
        clientOf(scope).query('UPDATE public.documents SET source_ref = $2 WHERE id = $1', [
          id,
          'x',
        ]),
      ),
    ).rejects.toMatchObject({ category: 'forbidden' });
    await expect(
      transactions.withTenant(orgA, (scope) =>
        clientOf(scope).query('DELETE FROM public.documents WHERE id = $1', [id]),
      ),
    ).rejects.toMatchObject({ category: 'forbidden' });
    await expect(
      transactions.withTenant(orgA, (scope) =>
        clientOf(scope).query('DELETE FROM public.document_texts WHERE document_id = $1', [id]),
      ),
    ).rejects.toMatchObject({ category: 'forbidden' });
  });
});
