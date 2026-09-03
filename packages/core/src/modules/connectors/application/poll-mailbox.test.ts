import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../../kernel/clock.js';
import { noExecutionContext } from '../../../kernel/context.js';
import { InfrastructureError } from '../../../kernel/errors.js';
import { newConnectionId, newOrganizationId, newUserId } from '../../../kernel/ids.js';
import type { TenantContext } from '../../../kernel/tenant.js';
import { authorizer } from '../../access/index.js';
import { AuditTrail, InMemoryAuditLogRepository } from '../../audit/index.js';
import {
  CompositeTextExtractor,
  HtmlTextExtractor,
  IngestDocument,
  InMemoryDocumentRepository,
  InMemoryDocumentStore,
  InMemoryDocumentTextRepository,
  PlainTextExtractor,
} from '../../documents/index.js';
import { EventLedger, InMemoryLedgerRepository } from '../../ledger/index.js';
import { InMemoryTransactionRunner } from '../../tenancy/index.js';
import { InMemoryObjectStorage } from '../../../infrastructure/storage/in-memory-object-storage.js';
import {
  InMemoryConnectionRepository,
  InMemoryConnectionStore,
} from '../adapters/memory/in-memory-connection-repositories.js';
import {
  FAKE_MAILBOX_PROVIDER,
  FakeMailboxFactory,
  type FakeMessage,
} from '../adapters/memory/fake-mailbox-connector.js';
import { EmailTextExtractor } from '../adapters/mime/email-text-extractor.js';
import { MailparserMimeParser } from '../adapters/mime/mailparser-mime-parser.js';
import { CredentialCipher } from '../domain/credential-cipher.js';
import { ConnectionSecrets } from './connection-secrets.js';
import { IngestMailboxMessage } from './ingest-mailbox-message.js';
import { ManageConnections } from './manage-connections.js';
import { PollMailbox } from './poll-mailbox.js';

const organizationId = newOrganizationId();
const owner: TenantContext = {
  organizationId,
  organizationSlug: 'a',
  userId: newUserId(),
  roleKey: 'owner',
};

const message = (id: string, body: string): Uint8Array =>
  new TextEncoder().encode(
    [
      'From: acquisti@officine-rossi.it',
      'To: vendite@alfa-meccanica.it',
      `Subject: Messaggio ${id}`,
      `Message-ID: <${id}@officine-rossi.it>`,
      '',
      body,
      '',
    ].join('\r\n'),
  );

const inbox = (...ids: string[]): FakeMessage[] =>
  ids.map((id, index) => ({
    uid: String(index + 1),
    raw: message(id, `Corpo del messaggio ${id}.`),
    receivedAt: new Date(`2026-09-03T0${String(index + 1)}:00:00.000Z`),
  }));

async function setup() {
  const clock = new FixedClock(new Date('2026-09-03T12:00:00.000Z'));
  const transactions = new InMemoryTransactionRunner();
  const store = new InMemoryConnectionStore(clock);
  const connections = new InMemoryConnectionRepository(store);
  const cipher = CredentialCipher.fromBase64(CredentialCipher.generateKeyBase64());
  const auditRepository = new InMemoryAuditLogRepository();
  const audit = new AuditTrail({ repository: auditRepository, clock, context: noExecutionContext });
  const documentStore = new InMemoryDocumentStore(clock);
  const documents = new InMemoryDocumentRepository(documentStore);
  const parser = new MailparserMimeParser();
  const scheduled: string[] = [];
  const ingest = new IngestMailboxMessage({
    transactions,
    parser,
    ingest: new IngestDocument({
      transactions,
      documents,
      texts: new InMemoryDocumentTextRepository(documentStore),
      storage: new InMemoryObjectStorage(clock),
      extractor: new CompositeTextExtractor([
        new EmailTextExtractor(parser),
        new PlainTextExtractor(),
        new HtmlTextExtractor(),
      ]),
      ledger: new EventLedger({
        repository: new InMemoryLedgerRepository(clock),
        context: noExecutionContext,
      }),
      clock,
    }),
    audit,
    clock,
    scheduler: {
      scheduleAnalysis: async (_tenant, documentId) => {
        scheduled.push(documentId);
      },
    },
  });
  const factory = new FakeMailboxFactory();
  const manage = new ManageConnections({
    transactions,
    connections,
    cipher,
    authorizer,
    audit,
    clock,
  });
  const created = await manage.create(owner, {
    capability: 'mailbox',
    provider: FAKE_MAILBOX_PROVIDER,
    displayName: 'Vendite',
    settings: { mailbox: 'INBOX' },
    credentials: { user: 'vendite@alfa-meccanica.it', pass: 'app-password' },
  });
  if (!created.ok) throw created.error;
  const poll = new PollMailbox({
    transactions,
    connections,
    secrets: new ConnectionSecrets({ connections, cipher }),
    factory,
    ingest,
    audit,
    clock,
    batchSize: 10,
  });
  return {
    clock,
    transactions,
    connections,
    documents,
    auditRepository,
    factory,
    manage,
    poll,
    scheduled,
    connectionId: created.value.id,
  };
}

describe('PollMailbox', () => {
  it('ingests new mail, advances the cursor and repeats without creating duplicates', async () => {
    const { poll, factory, connectionId, transactions, connections, documents, scheduled } =
      await setup();
    factory.for(connectionId).configure({ messages: inbox('m-1', 'm-2') });

    const first = await poll.execute(organizationId, connectionId);
    expect(first.ok && first.value).toMatchObject({ listed: 2, ingested: 2, duplicates: 0 });
    expect(scheduled).toHaveLength(2);

    const state = await transactions.withTenant(organizationId, (scope) =>
      connections.findById(scope, connectionId),
    );
    expect(state?.syncState).toEqual({ generation: '1', lastUid: '2' });
    expect(state?.status).toBe('active');
    expect(state?.lastSyncAt).not.toBeNull();

    // Nothing new: the second pass lists nothing rather than re-reading the mailbox.
    const second = await poll.execute(organizationId, connectionId);
    expect(second.ok && second.value).toMatchObject({ listed: 0, ingested: 0 });

    factory.for(connectionId).configure({ messages: inbox('m-1', 'm-2', 'm-3') });
    const third = await poll.execute(organizationId, connectionId);
    expect(third.ok && third.value).toMatchObject({ listed: 1, ingested: 1 });

    const stored = await transactions.withTenant(organizationId, (scope) =>
      documents.list(scope, { limit: 20, topLevelOnly: true }),
    );
    expect(stored).toHaveLength(3);
    expect(stored.every((document) => document.sourceRef.startsWith('mailbox:'))).toBe(true);
  });

  it('re-lists from the start when the provider renumbers, and stores no second copy', async () => {
    const { poll, factory, connectionId, transactions, documents } = await setup();
    const mailbox = factory.for(connectionId);
    mailbox.configure({ messages: inbox('m-1', 'm-2') });
    expect((await poll.execute(organizationId, connectionId)).ok).toBe(true);

    // A renumbering invalidates every stored uid, so the mailbox is read again.
    mailbox.configure({ generation: '2' });
    const afterReset = await poll.execute(organizationId, connectionId);
    expect(afterReset.ok && afterReset.value).toMatchObject({
      reset: true,
      listed: 2,
      ingested: 2,
    });
    const stored = await transactions.withTenant(organizationId, (scope) =>
      documents.list(scope, { limit: 20, topLevelOnly: true }),
    );
    // Four documents, because the same message under a new generation is a new
    // source reference. Deduplication of the message itself belongs to the
    // system reading it, which sees the same Message-ID.
    expect(stored).toHaveLength(4);
    expect(new Set(stored.map((document) => document.externalId)).size).toBe(2);
  });

  it('steps over a message that vanished between listing and fetching', async () => {
    const { poll, factory, connectionId, transactions, connections } = await setup();
    factory.for(connectionId).configure({
      messages: [
        { uid: '1', raw: message('m-1', 'primo'), receivedAt: new Date(), vanishes: true },
        { uid: '2', raw: message('m-2', 'secondo'), receivedAt: new Date() },
      ],
    });
    const report = await poll.execute(organizationId, connectionId);
    expect(report.ok && report.value).toMatchObject({ listed: 2, ingested: 1, missing: 1 });
    const state = await transactions.withTenant(organizationId, (scope) =>
      connections.findById(scope, connectionId),
    );
    expect(state?.syncState).toMatchObject({ lastUid: '2' });
  });

  it('records a provider failure on the connection without leaking credentials, and keeps the cursor', async () => {
    const { poll, factory, connectionId, transactions, connections, auditRepository } =
      await setup();
    const mailbox = factory.for(connectionId);
    mailbox.configure({ messages: inbox('m-1') });
    expect((await poll.execute(organizationId, connectionId)).ok).toBe(true);

    mailbox.configure({
      failListing: new InfrastructureError('IMAP_UNAVAILABLE', 'connection refused', {
        retryable: true,
      }),
    });
    const failed = await poll.execute(organizationId, connectionId);
    expect(!failed.ok && failed.error.code).toBe('IMAP_UNAVAILABLE');

    const state = await transactions.withTenant(organizationId, (scope) =>
      connections.findById(scope, connectionId),
    );
    expect(state?.status).toBe('error');
    expect(state?.lastError).toContain('IMAP_UNAVAILABLE');
    // The cursor survives the failure, so nothing is re-read or skipped on retry.
    expect(state?.syncState).toEqual({ generation: '1', lastUid: '1' });
    expect(JSON.stringify(state)).not.toContain('app-password');
    expect(JSON.stringify(auditRepository.entries)).not.toContain('app-password');

    // The connector is closed even when the pass fails.
    expect(mailbox.closed).toBe(true);

    // Recovery: the next successful pass clears the error.
    mailbox.configure({ failListing: undefined, messages: inbox('m-1', 'm-2') });
    const recovered = await poll.execute(organizationId, connectionId);
    expect(recovered.ok && recovered.value.ingested).toBe(1);
    const healthy = await transactions.withTenant(organizationId, (scope) =>
      connections.findById(scope, connectionId),
    );
    expect(healthy).toMatchObject({ status: 'active', lastError: null });
  });

  it('refuses to poll a disabled connection, a missing one and one that is not a mailbox', async () => {
    const { poll, manage, connectionId } = await setup();
    const missing = await poll.execute(organizationId, newConnectionId());
    expect(missing.ok).toBe(false);

    const issued = await manage.issueIngestionKey(owner, 'endpoint');
    if (!issued.ok) throw issued.error;
    const notAMailbox = await poll.execute(organizationId, issued.value.connection.id);
    expect(!notAMailbox.ok && notAMailbox.error.code).toBe('NOT_A_MAILBOX');

    expect((await manage.setStatus(owner, connectionId, 'disabled')).ok).toBe(true);
    const disabled = await poll.execute(organizationId, connectionId);
    expect(!disabled.ok && disabled.error.code).toBe('CONNECTION_DISABLED');
  });
});
