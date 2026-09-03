import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AuditTrail,
  CompositeTextExtractor,
  ConnectionSecrets,
  CredentialCipher,
  EmailTextExtractor,
  EventLedger,
  FAKE_MAILBOX_PROVIDER,
  FakeMailboxFactory,
  HtmlTextExtractor,
  IngestDocument,
  IngestMailboxMessage,
  InMemoryObjectStorage,
  MailparserMimeParser,
  ManageConnections,
  type ConnectionId,
  type OrganizationId,
  PlainTextExtractor,
  PollMailbox,
  PostgresAuditLogRepository,
  PostgresConnectionRepository,
  PostgresDocumentRepository,
  PostgresDocumentTextRepository,
  PostgresIngestionNonceRepository,
  PostgresLedgerRepository,
  PostgresMembershipRepository,
  PostgresOrganizationRepository,
  PostgresTransactionRunner,
  PostgresUserRepository,
  ProvisionOrganization,
  ReceiveSignedMessage,
  type TenantContext,
  authorizer,
  clientOf,
  noExecutionContext,
  noopLogger,
  systemClock,
  INGESTION_HEADER_NAMES,
  signIngestionRequest,
} from '@dolmir/core';

import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

/**
 * Connectors on real infrastructure: credentials encrypted at rest and bound
 * to their tenant, replay protection enforced by the database, a mailbox
 * polled end to end into documents and attachments, and the runtime role
 * unable to delete any of it.
 */
const MAILBOX_PASSWORD = 'app-specific-password-do-not-log';

const message = (id: string, withAttachment: boolean): Uint8Array =>
  new TextEncoder().encode(
    withAttachment
      ? [
          'From: "Ufficio Acquisti" <acquisti@officine-rossi.it>',
          'To: vendite@alfa-meccanica.it',
          `Subject: Richiesta ${id}`,
          `Message-ID: <${id}@officine-rossi.it>`,
          'MIME-Version: 1.0',
          'Content-Type: multipart/mixed; boundary="b"',
          '',
          '--b',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Chiediamo un preventivo per 250 flange in S355.',
          '',
          '--b',
          'Content-Type: text/csv',
          'Content-Disposition: attachment; filename="righe.csv"',
          '',
          'codice;quantita',
          'FL-250;250',
          '',
          '--b--',
          '',
        ].join('\r\n')
      : [
          'From: acquisti@officine-rossi.it',
          'To: vendite@alfa-meccanica.it',
          `Subject: Richiesta ${id}`,
          `Message-ID: <${id}@officine-rossi.it>`,
          '',
          'Chiediamo un preventivo per 250 flange in S355.',
          '',
        ].join('\r\n'),
  );

describe('connectors on PostgreSQL', () => {
  let db: TestDatabase;
  let transactions: PostgresTransactionRunner;
  /** Forced RLS hides every row outside a scope, so even the owner reads through one. */
  let ownerTransactions: PostgresTransactionRunner;
  let orgA: OrganizationId;
  let orgB: OrganizationId;
  let ownerA: TenantContext;
  let ownerB: TenantContext;
  let manage: ManageConnections;
  let poll: PollMailbox;
  let receive: ReceiveSignedMessage;
  let factory: FakeMailboxFactory;
  const connections = new PostgresConnectionRepository();
  const documents = new PostgresDocumentRepository();
  const texts = new PostgresDocumentTextRepository();
  const cipher = CredentialCipher.fromBase64(CredentialCipher.generateKeyBase64());
  let mailboxConnectionId: ConnectionId;

  beforeAll(async () => {
    db = await createTestDatabase();
    transactions = new PostgresTransactionRunner(db.appPool, noopLogger);
    ownerTransactions = new PostgresTransactionRunner(db.ownerPool, noopLogger);
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
      organization: { slug: 'a', name: 'Alfa Meccanica' },
      owner: { authSubject: 'auth|a' },
    });
    const b = await provision.execute({
      organization: { slug: 'b', name: 'B' },
      owner: { authSubject: 'auth|b' },
    });
    if (!a.ok || !b.ok) throw new Error('provisioning failed');
    orgA = a.value.organization.id;
    orgB = b.value.organization.id;
    ownerA = {
      organizationId: orgA,
      organizationSlug: 'a',
      userId: a.value.owner.id,
      roleKey: 'owner',
    };
    ownerB = {
      organizationId: orgB,
      organizationSlug: 'b',
      userId: b.value.owner.id,
      roleKey: 'owner',
    };

    const parser = new MailparserMimeParser();
    const ingest = new IngestMailboxMessage({
      transactions,
      parser,
      ingest: new IngestDocument({
        transactions,
        documents,
        texts,
        storage: new InMemoryObjectStorage(systemClock),
        extractor: new CompositeTextExtractor([
          new EmailTextExtractor(parser),
          new PlainTextExtractor(),
          new HtmlTextExtractor(),
        ]),
        ledger: new EventLedger({
          repository: new PostgresLedgerRepository(),
          context: noExecutionContext,
        }),
        clock: systemClock,
      }),
      audit,
      clock: systemClock,
    });
    const secrets = new ConnectionSecrets({ connections, cipher });
    factory = new FakeMailboxFactory();
    manage = new ManageConnections({
      transactions,
      connections,
      cipher,
      authorizer,
      audit,
      clock: systemClock,
    });
    poll = new PollMailbox({
      transactions,
      connections,
      secrets,
      factory,
      ingest,
      audit,
      clock: systemClock,
      batchSize: 10,
    });
    receive = new ReceiveSignedMessage({
      transactions,
      connections,
      secrets,
      nonces: new PostgresIngestionNonceRepository(),
      ingest,
      audit,
      clock: systemClock,
    });
  });

  afterAll(async () => {
    await db.drop();
  });

  it('stores credentials encrypted, bound to their tenant, and invisible to another tenant', async () => {
    const created = await manage.create(ownerA, {
      capability: 'mailbox',
      provider: FAKE_MAILBOX_PROVIDER,
      displayName: 'Vendite',
      settings: { mailbox: 'INBOX' },
      credentials: { user: 'vendite@alfa-meccanica.it', pass: MAILBOX_PASSWORD },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    mailboxConnectionId = created.value.id;
    expect(Object.keys(created.value)).not.toContain('credentials');

    // What is on disk is an envelope. The password appears nowhere in the row.
    const row = await ownerTransactions.withSystemScope('test', (scope) =>
      clientOf(scope).query<{ credentials: unknown; settings: unknown }>(
        'SELECT credentials, settings FROM public.tenant_connections WHERE id = $1',
        [mailboxConnectionId],
      ),
    );
    expect(JSON.stringify(row.rows[0])).not.toContain(MAILBOX_PASSWORD);
    expect(row.rows[0]?.credentials).toMatchObject({ v: 1, alg: 'aes-256-gcm' });

    const whole = await ownerTransactions.withSystemScope('test', (scope) =>
      clientOf(scope).query(
        "SELECT count(*)::int AS n FROM public.audit_log WHERE details::text LIKE '%' || $1 || '%'",
        [MAILBOX_PASSWORD],
      ),
    );
    expect(whole.rows[0]).toEqual({ n: 0 });

    // The other tenant sees nothing, and the envelope does not decrypt for it.
    const seenByB = await transactions.withTenant(orgB, (scope) =>
      connections.findById(scope, mailboxConnectionId),
    );
    expect(seenByB).toBeUndefined();
    const stored = await transactions.withTenant(orgA, (scope) =>
      connections.findById(scope, mailboxConnectionId),
    );
    expect(stored).toBeDefined();
    if (stored === undefined) return;
    expect(cipher.decrypt(orgA, stored.credentials).ok).toBe(true);
    expect(cipher.decrypt(orgB, stored.credentials).ok).toBe(false);

    const listedByB = await manage.list(ownerB, {});
    expect(listedByB.ok && listedByB.value).toEqual([]);
  });

  it('polls a mailbox into documents with attachments, texts and a ledger event', async () => {
    factory.for(mailboxConnectionId).configure({
      messages: [
        { uid: '1', raw: message('p-1', true), receivedAt: new Date('2026-09-03T08:00:00Z') },
        { uid: '2', raw: message('p-2', false), receivedAt: new Date('2026-09-03T09:00:00Z') },
      ],
    });
    const report = await poll.execute(orgA, mailboxConnectionId);
    expect(report.ok && report.value).toMatchObject({ listed: 2, ingested: 2, duplicates: 0 });

    const stored = await transactions.withTenant(orgA, async (scope) => {
      const top = await documents.list(scope, { limit: 20, topLevelOnly: true });
      const first = top.find((document) => document.externalId === 'p-1@officine-rossi.it');
      return {
        top,
        children: first === undefined ? [] : await documents.listChildren(scope, first.id),
        parts: first === undefined ? [] : await texts.listByDocument(scope, first.id),
      };
    });
    expect(stored.top).toHaveLength(2);
    expect(stored.children[0]).toMatchObject({
      kind: 'attachment',
      filename: 'righe.csv',
      contentType: 'text/csv',
      textStatus: 'extracted',
    });
    expect(stored.parts.map((part) => part.part)).toEqual([0, 1]);
    expect(stored.parts[1]?.text).toContain('250 flange in S355');

    const events = await transactions.withTenant(orgA, (scope) =>
      clientOf(scope).query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.ledger_events WHERE event_type = 'DocumentReceived'",
      ),
    );
    expect(events.rows[0]?.n).toBe(3);

    // Re-polling the same mailbox creates nothing new.
    const again = await poll.execute(orgA, mailboxConnectionId);
    expect(again.ok && again.value).toMatchObject({ listed: 0, ingested: 0 });
  });

  it('lets the database refuse a replayed nonce, per tenant', async () => {
    const issued = await manage.issueIngestionKey(ownerA, 'forwarder');
    if (!issued.ok) throw issued.error;
    const body = message('signed-1', false);
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = 'nonce-postgres-000001';
    const headers = {
      [INGESTION_HEADER_NAMES.keyId]: issued.value.keyId,
      [INGESTION_HEADER_NAMES.timestamp]: String(timestamp),
      [INGESTION_HEADER_NAMES.nonce]: nonce,
      [INGESTION_HEADER_NAMES.signature]: signIngestionRequest(
        Buffer.from(issued.value.secret, 'base64'),
        { keyId: issued.value.keyId, timestamp, nonce, body },
      ),
    };
    const delivered = await receive.execute({ tenantId: orgA, headers, body });
    expect(delivered.ok).toBe(true);
    const replayed = await receive.execute({ tenantId: orgA, headers, body });
    expect(!replayed.ok && replayed.error.code).toBe('SIGNATURE_REPLAYED');

    const nonces = await ownerTransactions.withSystemScope('test', (scope) =>
      clientOf(scope).query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.ingestion_nonces WHERE organization_id = $1',
        [orgA],
      ),
    );
    expect(nonces.rows[0]?.n).toBe(1);

    const seenByB = await transactions.withTenant(orgB, (scope) =>
      clientOf(scope).query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.ingestion_nonces',
      ),
    );
    expect(seenByB.rows[0]?.n).toBe(0);
  });

  it('gives the runtime role no way to delete a connection, a nonce or a document', async () => {
    const attempt = (sql: string) =>
      transactions.withTenant(orgA, (scope) => clientOf(scope).query(sql));
    for (const table of ['tenant_connections', 'ingestion_nonces', 'documents']) {
      await expect(attempt(`DELETE FROM public.${table}`)).rejects.toMatchObject({
        category: 'forbidden',
      });
    }
    await expect(attempt("UPDATE public.ingestion_nonces SET nonce = 'x'")).rejects.toMatchObject({
      category: 'forbidden',
    });
  });

  it('refuses a stale update, so two writers cannot both change a connection', async () => {
    const current = await transactions.withTenant(orgA, (scope) =>
      connections.findById(scope, mailboxConnectionId),
    );
    if (current === undefined) throw new Error('connection missing');
    const stale = await transactions.withTenant(orgA, (scope) =>
      connections.update(scope, mailboxConnectionId, current.version - 1, {
        displayName: 'Should not apply',
      }),
    );
    expect(stale).toBeUndefined();
    const fresh = await transactions.withTenant(orgA, (scope) =>
      connections.update(scope, mailboxConnectionId, current.version, { displayName: 'Vendite 2' }),
    );
    expect(fresh).toMatchObject({ displayName: 'Vendite 2', version: current.version + 1 });
  });
});
