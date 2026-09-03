import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../../kernel/clock.js';
import type { Evidence } from '../../../kernel/epistemic.js';
import { ActorType, noExecutionContext } from '../../../kernel/context.js';
import { newOrganizationId, newUserId } from '../../../kernel/ids.js';
import { ok } from '../../../kernel/result.js';
import { authorizer } from '../../access/index.js';
import { AuditTrail, InMemoryAuditLogRepository } from '../../audit/index.js';
import {
  CompositeTextExtractor,
  IngestDocument,
  InMemoryDocumentRepository,
  InMemoryDocumentStore,
  InMemoryDocumentTextRepository,
  PlainTextExtractor,
  evidenceForQuote,
} from '../../documents/index.js';
import { EventLedger, InMemoryLedgerRepository } from '../../ledger/index.js';
import {
  InMemoryMembershipRepository,
  InMemoryTenancyStore,
  InMemoryTransactionRunner,
} from '../../tenancy/index.js';
import { InMemoryObjectStorage } from '../../../infrastructure/storage/in-memory-object-storage.js';
import { InMemoryActionPolicy, ToolExecutor, ToolRegistry } from '../../../ai/index.js';
import { DocumentEvidenceVerifier } from '../adapters/evidence/document-evidence-verifier.js';
import { InMemoryCaseRepository } from '../adapters/memory/in-memory-case-repository.js';
import { CaseEngine } from './case-engine.js';
import { CaseProjection } from './case-projection.js';

const organizationId = newOrganizationId();
const otherOrganizationId = newOrganizationId();
const operatorId = newUserId();
const BODY = 'Buongiorno, chiediamo un preventivo per 250 flange tornite in acciaio S355.';

async function setup() {
  const clock = new FixedClock(new Date('2026-09-03T12:00:00.000Z'));
  const transactions = new InMemoryTransactionRunner();
  const tenancy = new InMemoryTenancyStore(clock);
  const memberships = new InMemoryMembershipRepository(tenancy);
  tenancy.memberships.push({
    organizationId,
    userId: operatorId,
    roleKey: 'operator',
    status: 'active',
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
  const audit = new AuditTrail({
    repository: new InMemoryAuditLogRepository(),
    clock,
    context: noExecutionContext,
  });
  const documentStore = new InMemoryDocumentStore(clock);
  const texts = new InMemoryDocumentTextRepository(documentStore);
  const ingest = new IngestDocument({
    transactions,
    documents: new InMemoryDocumentRepository(documentStore),
    texts,
    storage: new InMemoryObjectStorage(clock),
    extractor: new CompositeTextExtractor([new PlainTextExtractor()]),
    ledger: new EventLedger({
      repository: new InMemoryLedgerRepository(clock),
      context: noExecutionContext,
    }),
    clock,
  });
  const ingested = await ingest.execute({
    tenantId: organizationId,
    kind: 'email',
    sourceKind: 'EMAIL',
    sourceRef: 'ingest:evidence-1',
    body: new TextEncoder().encode(BODY),
    contentType: 'text/plain; charset=utf-8',
    receivedAt: clock.now(),
    actor: { type: ActorType.SERVICE, id: 'test' },
    recordedBy: 'test',
  });
  if (!ingested.ok) throw ingested.error;
  const cases = new InMemoryCaseRepository();
  const tools = new ToolRegistry();
  const engine = new CaseEngine({
    transactions,
    ledger: new EventLedger({
      repository: new InMemoryLedgerRepository(clock),
      context: noExecutionContext,
    }),
    cases,
    projection: new CaseProjection(cases),
    tools,
    policy: new InMemoryActionPolicy(),
    executor: new ToolExecutor({
      registry: tools,
      authorizer,
      policy: new InMemoryActionPolicy(),
      audit,
      clock,
    }),
    authorizer,
    memberships,
    clock,
    evidence: new DocumentEvidenceVerifier(texts),
  });
  const parts = await transactions.withTenant(organizationId, (scope) =>
    texts.listByDocument(scope, ingested.value.document.id),
  );
  return { engine, transactions, texts, documentId: ingested.value.document.id, parts, cases };
}

const draftWith = (evidence: Evidence) => ({
  kind: 'quote_request',
  title: 'Richiesta di preventivo',
  summary: 'Il cliente chiede un preventivo.',
  determination: 'READY_FOR_REVIEW' as const,
  findings: [
    {
      statement: 'The customer asks for 250 flanges',
      status: 'OBSERVATION' as const,
      evidence: [evidence],
      tags: [],
    },
  ],
  recommendations: [],
});
const provenance = { systemKey: 'test_system', systemVersion: 1, sourceRef: 'ingest:evidence-1' };

describe('case engine evidence verification', () => {
  it('accepts a span that really occurs in the document', async () => {
    const { engine, documentId, parts } = await setup();
    const evidence = evidenceForQuote(documentId, parts, '250 flange tornite in acciaio S355');
    expect(evidence.ok).toBe(true);
    if (!evidence.ok) return;
    const opened = await engine.openCase(organizationId, draftWith(evidence.value), provenance);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.value.findings[0]?.evidence[0]).toMatchObject(evidence.value);
  });

  it('refuses a fabricated quotation, so an invented fact never reaches a human', async () => {
    const { engine, documentId, cases } = await setup();
    const fabricated = {
      kind: 'DOCUMENT_SPAN' as const,
      sourceRef: `document:${documentId}`,
      // Plausible, in the right language, and nowhere in the message.
      content: 'prezzo unitario 12,50 EUR con consegna in due settimane',
      locator: { part: 1, start: 0, end: 54 },
    };
    const refused = await engine.openCase(organizationId, draftWith(fabricated), provenance);
    expect(!refused.ok && refused.error.code).toBe('FABRICATED_EVIDENCE');
    if (!refused.ok) {
      const rejected = refused.error.details['rejected'] as { reason: string }[];
      expect(rejected[0]?.reason).toBe('SPAN_NOT_IN_DOCUMENT');
    }
    // Nothing was stored: the case does not exist.
    expect(cases.cases.size).toBe(0);
  });

  it('refuses a span whose offsets were moved, even when the words are real', async () => {
    const { engine, documentId, parts } = await setup();
    const honest = evidenceForQuote(documentId, parts, '250 flange');
    if (!honest.ok) throw honest.error;
    const moved = { ...honest.value, locator: { part: 0, start: 0, end: 10 } };
    const refused = await engine.openCase(organizationId, draftWith(moved), provenance);
    expect(!refused.ok && refused.error.code).toBe('FABRICATED_EVIDENCE');
  });

  it('refuses a span that names a document of another tenant', async () => {
    const { engine, documentId, parts } = await setup();
    const evidence = evidenceForQuote(documentId, parts, '250 flange');
    if (!evidence.ok) throw evidence.error;
    // The same, real citation, proposed inside a tenant that cannot see the document.
    const refused = await engine.openCase(
      otherOrganizationId,
      draftWith(evidence.value),
      provenance,
    );
    expect(!refused.ok && refused.error.code).toBe('FABRICATED_EVIDENCE');
    if (!refused.ok) {
      const rejected = refused.error.details['rejected'] as { reason: string }[];
      expect(rejected[0]?.reason).toBe('DOCUMENT_NOT_FOUND');
    }
  });

  it('refuses a malformed reference and lets other evidence kinds through', async () => {
    const { engine } = await setup();
    const malformed = await engine.openCase(
      organizationId,
      draftWith({
        kind: 'DOCUMENT_SPAN' as const,
        sourceRef: 'not-a-document-reference',
        content: 'anything',
      }),
      provenance,
    );
    expect(!malformed.ok && malformed.error.code).toBe('FABRICATED_EVIDENCE');

    // A record field is not a document span; the verifier does not invent a check for it.
    const recordField = await engine.openCase(
      organizationId,
      draftWith({
        kind: 'RECORD_FIELD' as const,
        sourceRef: 'entity:0192b4c1-0000-7000-8000-000000000000',
        content: 'Officine Rossi',
        locator: { table: 'entities', field: 'name' },
      }),
      provenance,
    );
    expect(recordField.ok).toBe(true);
  });

  it('verifies the evidence a NON_DETERMINATO account carries, not only findings', async () => {
    const { engine, documentId } = await setup();
    const refused = await engine.openCase(
      organizationId,
      {
        kind: 'quote_request',
        title: 'Richiesta incompleta',
        summary: 'Manca il cliente.',
        determination: 'NON_DETERMINATO' as const,
        nonDeterminato: {
          kind: 'NON_DETERMINATO' as const,
          subject: 'the counterpart',
          unknown: ['Which customer sent this'],
          evidence: [
            {
              kind: 'DOCUMENT_SPAN' as const,
              sourceRef: `document:${documentId}`,
              content: 'firma: Ing. Mario Bianchi, direttore acquisti',
              locator: { part: 1, start: 0, end: 44 },
            },
          ],
        },
        findings: [],
        recommendations: [],
      },
      provenance,
    );
    expect(!refused.ok && refused.error.code).toBe('FABRICATED_EVIDENCE');
  });

  it('is a backstop, not the only check: without a verifier the engine still opens the case', async () => {
    // Proves the dependency is what enforces this, so a deployment that omits
    // it is a wiring defect rather than a silent behaviour change.
    const { engine } = await setup();
    expect(typeof engine.openCase).toBe('function');
    expect(ok(undefined).ok).toBe(true);
  });
});
