import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../../kernel/clock.js';
import { ActorType, noExecutionContext } from '../../../kernel/context.js';
import { newOrganizationId } from '../../../kernel/ids.js';
import { InMemoryObjectStorage } from '../../../infrastructure/storage/in-memory-object-storage.js';
import { EventLedger, InMemoryLedgerRepository } from '../../ledger/index.js';
import { InMemoryTransactionRunner } from '../../tenancy/index.js';
import { defaultTextExtractor } from '../adapters/extractors/text-extractors.js';
import {
  InMemoryDocumentRepository,
  InMemoryDocumentStore,
  InMemoryDocumentTextRepository,
} from '../adapters/memory/in-memory-document-repositories.js';
import { IngestDocument } from './ingest-document.js';

const tenantId = newOrganizationId();
const actor = { type: ActorType.SERVICE, id: 'mailbox-poller' };

function setup() {
  const clock = new FixedClock(new Date('2026-09-03T08:00:00.000Z'));
  const store = new InMemoryDocumentStore(clock);
  const ledgerRepository = new InMemoryLedgerRepository(clock);
  const ingest = new IngestDocument({
    transactions: new InMemoryTransactionRunner(),
    documents: new InMemoryDocumentRepository(store),
    texts: new InMemoryDocumentTextRepository(store),
    storage: new InMemoryObjectStorage(clock),
    extractor: defaultTextExtractor(),
    ledger: new EventLedger({ repository: ledgerRepository, context: noExecutionContext }),
    clock,
  });
  return { clock, store, ledgerRepository, ingest };
}

const body = new TextEncoder().encode('Buongiorno,\npotete inviarci un preventivo per 250 flange?');

describe('IngestDocument', () => {
  it('stores the bytes, the document, its text and a DocumentReceived event with provenance', async () => {
    const { ingest, ledgerRepository } = setup();
    const result = await ingest.execute({
      tenantId,
      kind: 'email',
      sourceKind: 'EMAIL',
      sourceRef: 'imap:acquisti@example.test:42',
      externalId: '<abc@example.test>',
      body,
      contentType: 'text/plain; charset=utf-8',
      receivedAt: new Date('2026-09-02T09:15:00.000Z'),
      metadata: { subject: 'Richiesta preventivo flange', from: 'acquisti@cliente.test' },
      actor,
      recordedBy: 'connectors.mailbox',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.duplicate).toBe(false);
    expect(result.value.document).toMatchObject({
      organizationId: tenantId,
      kind: 'email',
      parentId: null,
      sourceRef: 'imap:acquisti@example.test:42',
      externalId: '<abc@example.test>',
      contentType: 'text/plain; charset=utf-8',
      sizeBytes: body.byteLength,
      textStatus: 'extracted',
      metadata: { subject: 'Richiesta preventivo flange', from: 'acquisti@cliente.test' },
    });
    expect(result.value.document.objectKey.startsWith(`${tenantId}/documents/`)).toBe(true);
    expect(result.value.texts).toHaveLength(1);
    expect(result.value.texts[0]?.text).toContain('250 flange');

    expect(ledgerRepository.events).toHaveLength(1);
    expect(ledgerRepository.events[0]).toMatchObject({
      organizationId: tenantId,
      stream: { type: 'document', id: result.value.document.id },
      eventType: 'DocumentReceived',
      payload: { documentId: result.value.document.id, kind: 'email', textStatus: 'extracted' },
      provenance: {
        sourceKind: 'EMAIL',
        sourceRef: 'imap:acquisti@example.test:42',
        actor,
        recordedBy: 'connectors.mailbox',
      },
      occurredAt: new Date('2026-09-02T09:15:00.000Z'),
      idempotencyKey: 'document-received:imap:acquisti@example.test:42',
    });
  });

  it('is idempotent on the source reference: a redelivery returns the existing document', async () => {
    const { ingest, store, ledgerRepository } = setup();
    const input = {
      tenantId,
      kind: 'email' as const,
      sourceKind: 'EMAIL' as const,
      sourceRef: 'ingest:<msg-1@cliente.test>',
      body,
      contentType: 'text/plain',
      receivedAt: new Date(),
      actor,
      recordedBy: 'api.ingest',
    };
    const first = await ingest.execute(input);
    const second = await ingest.execute({ ...input, body: new TextEncoder().encode('different') });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.duplicate).toBe(true);
    expect(second.value.document.id).toBe(first.value.document.id);
    expect(store.documents.size).toBe(1);
    expect(ledgerRepository.events).toHaveLength(1);
  });

  it('records attachments as children and marks unsupported formats honestly', async () => {
    const { ingest } = setup();
    const parent = await ingest.execute({
      tenantId,
      kind: 'email',
      sourceKind: 'EMAIL',
      sourceRef: 'imap:x:1',
      body,
      contentType: 'text/plain',
      receivedAt: new Date(),
      actor,
      recordedBy: 'connectors.mailbox',
    });
    if (!parent.ok) throw parent.error;
    const attachment = await ingest.execute({
      tenantId,
      kind: 'attachment',
      parentId: parent.value.document.id,
      sourceKind: 'EMAIL',
      sourceRef: 'imap:x:1/disegno.pdf',
      body: new TextEncoder().encode('%PDF-1.4 fake'),
      contentType: 'application/pdf',
      filename: 'disegno.pdf',
      receivedAt: new Date(),
      actor,
      recordedBy: 'connectors.mailbox',
    });
    expect(attachment.ok).toBe(true);
    if (!attachment.ok) return;
    expect(attachment.value.document).toMatchObject({
      kind: 'attachment',
      parentId: parent.value.document.id,
      filename: 'disegno.pdf',
      textStatus: 'unsupported',
    });
    expect(attachment.value.texts).toEqual([]);
  });

  it('rejects invalid input as a value', async () => {
    const { ingest } = setup();
    const result = await ingest.execute({
      tenantId,
      kind: 'email',
      sourceKind: 'EMAIL',
      sourceRef: '',
      body,
      contentType: 'text/plain',
      receivedAt: new Date(),
      actor,
      recordedBy: 'x',
    });
    expect(!result.ok && result.error.code).toBe('INVALID_DOCUMENT');
  });
});
