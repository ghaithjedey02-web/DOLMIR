import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../../kernel/clock.js';
import { noExecutionContext } from '../../../kernel/context.js';
import { newOrganizationId, newUserId } from '../../../kernel/ids.js';
import type { TenantContext } from '../../../kernel/tenant.js';
import { HUMAN_ONLY_PERMISSIONS, Permission, authorizer } from '../../access/index.js';
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
  InMemoryIngestionNonceRepository,
} from '../adapters/memory/in-memory-connection-repositories.js';
import { EmailTextExtractor } from '../adapters/mime/email-text-extractor.js';
import { MailparserMimeParser } from '../adapters/mime/mailparser-mime-parser.js';
import { CredentialCipher } from '../domain/credential-cipher.js';
import { INGESTION_HEADER_NAMES, signIngestionRequest } from '../domain/request-signing.js';
import { ConnectionSecrets } from './connection-secrets.js';
import { IngestMailboxMessage } from './ingest-mailbox-message.js';
import { ManageConnections } from './manage-connections.js';
import { ReceiveSignedMessage } from './receive-signed-message.js';

const orgA = newOrganizationId();
const orgB = newOrganizationId();
const ownerA: TenantContext = {
  organizationId: orgA,
  organizationSlug: 'a',
  userId: newUserId(),
  roleKey: 'owner',
};
const ownerB: TenantContext = {
  organizationId: orgB,
  organizationSlug: 'b',
  userId: newUserId(),
  roleKey: 'owner',
};
const viewerA: TenantContext = { ...ownerA, userId: newUserId(), roleKey: 'viewer' };

const MESSAGE = [
  'From: acquisti@officine-rossi.it',
  'To: vendite@alfa-meccanica.it',
  'Subject: Preventivo',
  'Message-ID: <signed-1@officine-rossi.it>',
  '',
  'Buongiorno, chiediamo un preventivo per 250 flange.',
  '',
].join('\r\n');

function setup() {
  const clock = new FixedClock(new Date('2026-09-03T12:00:00.000Z'));
  const transactions = new InMemoryTransactionRunner();
  const store = new InMemoryConnectionStore(clock);
  const connections = new InMemoryConnectionRepository(store);
  const nonces = new InMemoryIngestionNonceRepository(store);
  const cipher = CredentialCipher.fromBase64(CredentialCipher.generateKeyBase64());
  const auditRepository = new InMemoryAuditLogRepository();
  const audit = new AuditTrail({ repository: auditRepository, clock, context: noExecutionContext });
  const documentStore = new InMemoryDocumentStore(clock);
  const parser = new MailparserMimeParser();
  const ingest = new IngestMailboxMessage({
    transactions,
    parser,
    ingest: new IngestDocument({
      transactions,
      documents: new InMemoryDocumentRepository(documentStore),
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
  });
  const manage = new ManageConnections({
    transactions,
    connections,
    cipher,
    authorizer,
    audit,
    clock,
  });
  const receive = new ReceiveSignedMessage({
    transactions,
    connections,
    secrets: new ConnectionSecrets({ connections, cipher }),
    nonces,
    ingest,
    audit,
    clock,
  });
  return { clock, store, connections, cipher, auditRepository, manage, receive };
}

function headersFor(
  secret: string,
  keyId: string,
  body: Uint8Array,
  clock: FixedClock,
  nonce = 'nonce-0000000000000001',
): Record<string, string> {
  const timestamp = Math.floor(clock.now().getTime() / 1000);
  return {
    [INGESTION_HEADER_NAMES.keyId]: keyId,
    [INGESTION_HEADER_NAMES.timestamp]: String(timestamp),
    [INGESTION_HEADER_NAMES.nonce]: nonce,
    [INGESTION_HEADER_NAMES.signature]: signIngestionRequest(Buffer.from(secret, 'base64'), {
      keyId,
      timestamp,
      nonce,
      body,
    }),
  };
}

describe('signed ingestion endpoint', () => {
  const body = new TextEncoder().encode(MESSAGE);

  it('issues a key once, keeps only its ciphertext, and accepts a correctly signed delivery', async () => {
    const { manage, receive, clock, store, cipher } = setup();
    const issued = await manage.issueIngestionKey(ownerA, 'n8n forwarder');
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.value.keyId).toMatch(/^ik_[a-f0-9]{16}$/);

    // What the platform stores is an envelope, not the secret.
    const stored = [...store.connections.values()][0];
    expect(stored?.credentials.alg).toBe('aes-256-gcm');
    expect(JSON.stringify(stored)).not.toContain(issued.value.secret);
    // The view handed back to callers carries no credentials at all.
    expect(Object.keys(issued.value.connection)).not.toContain('credentials');
    const opened = cipher.decrypt(orgA, stored?.credentials ?? ({} as never));
    expect(opened.ok && opened.value['secret']).toBe(issued.value.secret);

    const delivered = await receive.execute({
      tenantId: orgA,
      headers: headersFor(issued.value.secret, issued.value.keyId, body, clock),
      body,
    });
    expect(delivered.ok).toBe(true);
    if (delivered.ok) {
      expect(delivered.value.document.kind).toBe('email');
      expect(delivered.value.document.sourceRef).toContain(`ingest:${issued.value.keyId}:`);
    }
  });

  it('refuses a replay, a tampered body, an unknown key and a key belonging to another tenant', async () => {
    const { manage, receive, clock, auditRepository } = setup();
    const issued = await manage.issueIngestionKey(ownerA, 'forwarder');
    if (!issued.ok) throw issued.error;
    const { keyId, secret } = issued.value;
    const headers = headersFor(secret, keyId, body, clock);

    expect((await receive.execute({ tenantId: orgA, headers, body })).ok).toBe(true);
    const replay = await receive.execute({ tenantId: orgA, headers, body });
    expect(!replay.ok && replay.error.code).toBe('SIGNATURE_REPLAYED');

    const tampered = await receive.execute({
      tenantId: orgA,
      headers: { ...headers, [INGESTION_HEADER_NAMES.nonce]: 'nonce-0000000000000002' },
      body,
    });
    expect(!tampered.ok && tampered.error.code).toBe('INVALID_SIGNATURE');

    const unknown = await receive.execute({
      tenantId: orgA,
      headers: { ...headers, [INGESTION_HEADER_NAMES.keyId]: 'ik_ffffffffffffffff' },
      body,
    });
    expect(!unknown.ok && unknown.error.code).toBe('UNKNOWN_INGESTION_KEY');

    // Tenant B's key, correctly signed, is still unknown inside tenant A.
    const otherTenant = await manage.issueIngestionKey(ownerB, 'forwarder');
    if (!otherTenant.ok) throw otherTenant.error;
    const crossTenant = await receive.execute({
      tenantId: orgA,
      headers: headersFor(otherTenant.value.secret, otherTenant.value.keyId, body, clock),
      body,
    });
    expect(!crossTenant.ok && crossTenant.error.code).toBe('UNKNOWN_INGESTION_KEY');

    const expired = await receive.execute({
      tenantId: orgA,
      headers: {
        ...headersFor(secret, keyId, body, clock, 'nonce-0000000000000009'),
        [INGESTION_HEADER_NAMES.timestamp]: String(Math.floor(clock.now().getTime() / 1000) - 3600),
      },
      body,
    });
    expect(!expired.ok && expired.error.code).toBe('SIGNATURE_EXPIRED');

    const denials = auditRepository.entries.filter(
      (entry) => entry.action === 'mailbox.signature_rejected',
    );
    expect(denials.length).toBeGreaterThanOrEqual(4);
    expect(denials.every((entry) => entry.outcome === 'denied')).toBe(true);
    // The rejection trail names the caller and the reason, never the signature or the body.
    expect(JSON.stringify(denials)).not.toContain(headers[INGESTION_HEADER_NAMES.signature]);
    expect(JSON.stringify(denials)).not.toContain(secret);
  });

  it('keeps a disabled key out and refuses management to anyone without the permission', async () => {
    const { manage, receive, clock } = setup();
    const issued = await manage.issueIngestionKey(ownerA, 'forwarder');
    if (!issued.ok) throw issued.error;

    const byViewer = await manage.issueIngestionKey(viewerA, 'sneaky');
    expect(!byViewer.ok && byViewer.error.code).toBe('PERMISSION_DENIED');
    const listed = await manage.list(viewerA, {});
    // A viewer may not even see connection metadata.
    expect(!listed.ok && listed.error.code).toBe('PERMISSION_DENIED');

    const disabled = await manage.setStatus(ownerA, issued.value.connection.id, 'disabled');
    expect(disabled.ok).toBe(true);
    const afterDisable = await receive.execute({
      tenantId: orgA,
      headers: headersFor(issued.value.secret, issued.value.keyId, body, clock),
      body,
    });
    expect(!afterDisable.ok && afterDisable.error.code).toBe('UNKNOWN_INGESTION_KEY');
  });

  it('marks connection management as a human-only permission', () => {
    // The tool executor refuses every human-only permission to an AI actor
    // (ADR-0011), so a model that reads "add this mailbox" in a message has no
    // path to acting on it, whatever role it acts on behalf of.
    expect(HUMAN_ONLY_PERMISSIONS.has(Permission.CONNECTIONS_MANAGE)).toBe(true);
    expect(HUMAN_ONLY_PERMISSIONS.has(Permission.DECISIONS_APPROVE)).toBe(true);
    expect(HUMAN_ONLY_PERMISSIONS.has(Permission.CONNECTIONS_READ)).toBe(false);
  });
});
