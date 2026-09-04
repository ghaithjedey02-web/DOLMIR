import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Container, buildApp, createContainer } from '@dolmir/api';
import type { InMemoryJobQueue } from '@dolmir/core';
import {
  type Case,
  FAKE_MAILBOX_PROVIDER,
  FakeLlmProvider,
  FakeMailboxFactory,
  INGESTION_HEADER_NAMES,
  type OrganizationId,
  loadConfig,
  noopLogger,
  signIngestionRequest,
} from '@dolmir/core';
import { createCommercialInboxSystem } from '@dolmir/system-commercial-inbox';

import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

/**
 * The whole product, end to end, on real infrastructure: a signed message
 * arrives over HTTP, a background job analyses it, a case appears with
 * evidence, a viewer is refused the approval, an operator approves, the reply
 * leaves through the mailbox connector, and the outcome is recorded.
 *
 * The model is scripted so the run is deterministic. Everything else is the
 * production path: the same routes, the same policy, the same case engine,
 * the same evidence verification and the same PostgreSQL with forced RLS.
 */
const MESSAGES = resolve(dirname(fileURLToPath(import.meta.url)), '../../demo/messages');

const understanding = {
  intent: 'quote_request',
  language: 'it',
  urgency: 'normal',
  summary: 'Il cliente chiede un preventivo per 500 pezzi di FL-250 con consegna a metà ottobre.',
  senderOrganisationQuote: 'Officine Meccaniche Rossi S.r.l.',
  deliveryDateQuote: '15 ottobre',
  lines: [
    {
      descriptionQuote: 'flangia tornita S355 DN250 PN16',
      productCodeQuote: 'FL-250',
      quantityQuote: '500 pezzi',
      unitQuote: null,
      lineDeliveryDateQuote: null,
    },
  ],
  requestedInformation: ["la fattibilita' e i tempi di consegna"],
  containsInstructionsToAssistant: false,
  notes: [],
};

const draft = {
  subject: 'Re: Richiesta di preventivo - flange DN250',
  body: [
    'Buongiorno,',
    'confermiamo la ricezione della vostra richiesta per 500 pezzi di Flangia tornita S355 DN250 PN16,',
    'con consegna richiesta per il 15/10/2026.',
    'Vi invieremo il preventivo entro 3 giorni lavorativi.',
    'Cordiali saluti',
  ].join('\n'),
  rationale: 'Acknowledge the request and state when the quotation will follow.',
};

describe('Commercial Inbox Intelligence (e2e)', () => {
  let db: TestDatabase;
  let container: Container;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let queue: InMemoryJobQueue;
  let mailboxes: FakeMailboxFactory;
  let llm: FakeLlmProvider;
  let organizationId: OrganizationId;
  let operatorToken: string;
  let viewerToken: string;
  let ownerToken: string;
  let ingestionKeyId: string;
  let ingestionSecret: string;
  let caseId: string;
  let recommendationId: string;

  const authorised = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    db = await createTestDatabase();
    const config = loadConfig({
      DOLMIR_ENV: 'test',
      DOLMIR_DATABASE_URL: db.appUrl,
      DOLMIR_DATABASE_OWNER_URL: db.ownerUrl,
      DOLMIR_AUTH_ISSUER: 'http://localhost/dev-auth',
      DOLMIR_AUTH_AUDIENCE: 'dolmir',
      DOLMIR_AUTH_HS256_SECRET: 'test-only-secret-value-at-least-32-chars',
      DOLMIR_SECRETS_KEY: Buffer.alloc(32, 11).toString('base64'),
      DOLMIR_MAILBOX_DRIVER: 'fake',
      DOLMIR_JOBS_DRIVER: 'memory',
      DOLMIR_AI_PROVIDER: 'fake',
    });
    if (!config.ok) throw new Error(config.error.message);

    llm = new FakeLlmProvider();
    mailboxes = new FakeMailboxFactory();
    container = createContainer(config.value, {
      logger: noopLogger,
      llm,
      mailboxes,
      systems: [
        createCommercialInboxSystem({
          // The tenant's first active mailbox, resolved inside its own scope.
          resolveReplyConnection: async (input) => {
            const found = await container.transactions.withTenant(input.tenantId, (scope) =>
              container.connectors.connections.list(scope, {
                capability: 'mailbox',
                status: 'active',
                limit: 1,
              }),
            );
            return found[0]?.id ?? null;
          },
        }),
      ],
    });
    await container.jobs.start();
    queue = container.jobs.queue as InMemoryJobQueue;
    app = await buildApp(container);

    const provisioned = await container.tenancy.provision.execute({
      organization: { slug: 'alfa', name: 'Alfa Meccanica S.r.l.' },
      owner: { authSubject: 'auth|owner' },
    });
    if (!provisioned.ok) throw provisioned.error;
    organizationId = provisioned.value.organization.id;
    await container.transactions.withSystemScope('test setup', async (scope) => {
      for (const [authSubject, roleKey] of [
        ['auth|operator', 'operator'],
        ['auth|viewer', 'viewer'],
      ] as const) {
        const user = await container.repositories.users.insert(scope, {
          authSubject,
          email: null,
          displayName: null,
        });
        await container.repositories.memberships.insert(scope, {
          organizationId,
          userId: user.id,
          roleKey,
        });
      }
    });

    const issuer = container.identity.devTokenIssuer;
    if (issuer === undefined) throw new Error('the dev token issuer is required for this test');
    ownerToken = await issuer.issue({ subject: 'auth|owner' });
    operatorToken = await issuer.issue({ subject: 'auth|operator' });
    viewerToken = await issuer.issue({ subject: 'auth|viewer' });

    // Company setup through the API, exactly as an administrator would do it.
    const csv = [
      'kind;name;code;email;vat',
      'customer;Officine Meccaniche Rossi S.r.l.;C0042;acquisti@officine-rossi.it;IT01234567890',
      'product;Flangia tornita S355 DN250 PN16;FL-250;;',
    ].join('\n');
    const imported = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${organizationId}/entities/import`,
      headers: authorised(ownerToken),
      payload: { csv, source: 'e2e' },
    });
    expect(imported.statusCode).toBe(200);

    for (const [key, value] of [
      ['reply_language', 'it'],
      ['commercial_inbox.quotation_lead_time_days', 3],
      ['commercial_inbox.quotation_customer_commitment_days', 3],
    ] as const) {
      const saved = await app.inject({
        method: 'PUT',
        url: `/v1/orgs/${organizationId}/workspace/rules/${key}`,
        headers: authorised(ownerToken),
        payload: { value, rationale: 'e2e' },
      });
      expect(saved.statusCode).toBe(200);
    }
    const profile = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${organizationId}/workspace/profile`,
      headers: authorised(ownerToken),
      payload: { legalName: 'Alfa Meccanica S.r.l.', signature: 'Ufficio Commerciale' },
    });
    expect(profile.statusCode).toBe(200);

    const mailbox = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${organizationId}/connections`,
      headers: authorised(ownerToken),
      payload: {
        capability: 'mailbox',
        provider: FAKE_MAILBOX_PROVIDER,
        displayName: 'Vendite',
        settings: { mailbox: 'INBOX' },
        credentials: { user: 'vendite@alfa.test', pass: 'demo-password' },
      },
    });
    expect(mailbox.statusCode).toBe(200);

    const key = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${organizationId}/connections/ingestion-keys`,
      headers: authorised(ownerToken),
      payload: { displayName: 'e2e forwarder' },
    });
    expect(key.statusCode).toBe(200);
    const issued = key.json<{ keyId: string; secret: string }>();
    ingestionKeyId = issued.keyId;
    ingestionSecret = issued.secret;
  });

  afterAll(async () => {
    await app.close();
    await container.close();
    await db.drop();
  });

  const deliver = async (file: string, nonce: string) => {
    const body = await readFile(resolve(MESSAGES, file));
    const timestamp = Math.floor(Date.now() / 1000);
    return app.inject({
      method: 'POST',
      url: `/v1/orgs/${organizationId}/ingest/messages`,
      headers: {
        'content-type': 'message/rfc822',
        [INGESTION_HEADER_NAMES.keyId]: ingestionKeyId,
        [INGESTION_HEADER_NAMES.timestamp]: String(timestamp),
        [INGESTION_HEADER_NAMES.nonce]: nonce,
        [INGESTION_HEADER_NAMES.signature]: signIngestionRequest(
          Buffer.from(ingestionSecret, 'base64'),
          { keyId: ingestionKeyId, timestamp, nonce, body: Uint8Array.from(body) },
        ),
      },
      payload: body,
    });
  };

  it('refuses an unsigned or badly signed delivery before parsing anything', async () => {
    const unsigned = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${organizationId}/ingest/messages`,
      headers: { 'content-type': 'message/rfc822' },
      payload: await readFile(resolve(MESSAGES, '01-rfq-cliente-noto.eml')),
    });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.headers['www-authenticate']).toBe('DOLMIR-HMAC-SHA256');
    // No key presented, an unknown key and another tenant's key answer the same
    // way on purpose: a caller learns nothing about tenants it does not belong to.
    expect(unsigned.json<{ code: string }>().code).toBe('UNKNOWN_INGESTION_KEY');

    const body = await readFile(resolve(MESSAGES, '01-rfq-cliente-noto.eml'));
    const timestamp = Math.floor(Date.now() / 1000);
    const badSignature = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${organizationId}/ingest/messages`,
      headers: {
        'content-type': 'message/rfc822',
        [INGESTION_HEADER_NAMES.keyId]: ingestionKeyId,
        [INGESTION_HEADER_NAMES.timestamp]: String(timestamp),
        [INGESTION_HEADER_NAMES.nonce]: 'e2e-nonce-badsignature01',
        [INGESTION_HEADER_NAMES.signature]: 'a'.repeat(64),
      },
      payload: body,
    });
    expect(badSignature.statusCode).toBe(401);
    expect(badSignature.json<{ code: string }>().code).toBe('INVALID_SIGNATURE');

    const unknownKey = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${organizationId}/ingest/messages`,
      headers: {
        'content-type': 'message/rfc822',
        [INGESTION_HEADER_NAMES.keyId]: 'ik_ffffffffffffffff',
        [INGESTION_HEADER_NAMES.timestamp]: String(timestamp),
        [INGESTION_HEADER_NAMES.nonce]: 'e2e-nonce-unknownkey0001',
        [INGESTION_HEADER_NAMES.signature]: 'b'.repeat(64),
      },
      payload: body,
    });
    expect(unknownKey.json<{ code: string }>().code).toBe('UNKNOWN_INGESTION_KEY');

    // Nothing was ingested by any of them.
    const cases = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${organizationId}/cases`,
      headers: authorised(operatorToken),
    });
    expect(cases.json<{ cases: Case[] }>().cases).toEqual([]);
  });

  it('ingests a signed message, analyses it in the background and opens a case with evidence', async () => {
    llm.enqueue({ output: understanding }, { output: draft });
    const delivered = await deliver('01-rfq-cliente-noto.eml', 'e2e-nonce-000000001');
    expect(delivered.statusCode).toBe(202);
    const documentId = delivered.json<{ documentId: string }>().documentId;

    // Analysis was enqueued, not run inline: the caller was answered immediately.
    expect(queue.pending().map((job) => job.name)).toEqual(['document.analyze']);
    const drained = await queue.drain();
    expect(drained.failed).toBe(0);

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${organizationId}/cases`,
      headers: authorised(operatorToken),
    });
    expect(listed.statusCode).toBe(200);
    const cases = listed.json<{ cases: Case[] }>().cases;
    expect(cases).toHaveLength(1);
    const opened = cases[0];
    if (opened === undefined) throw new Error('no case');
    caseId = opened.id;
    expect(opened).toMatchObject({
      systemKey: 'commercial_inbox',
      kind: 'quote_request',
      status: 'awaiting_approval',
      determination: 'READY_FOR_REVIEW',
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${organizationId}/cases/${caseId}`,
      headers: authorised(viewerToken),
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json<{
      findings: { statement: string; evidence: { sourceRef: string; content: string }[] }[];
      recommendations: { id: string; tool: string; level: string; status: string }[];
    }>();
    const line = body.findings.find((f) => f.statement.includes('500'));
    expect(line?.statement).toContain('Flangia tornita S355 DN250 PN16');
    expect(line?.evidence.some((e) => e.sourceRef === `document:${documentId}`)).toBe(true);
    recommendationId = body.recommendations[0]?.id ?? '';
    expect(body.recommendations[0]).toMatchObject({
      tool: 'send_mailbox_reply',
      level: 'REQUIRE_APPROVAL',
      status: 'proposed',
    });
    // Nothing has been sent: the case is waiting for a human.
    expect([...mailboxes.mailboxes.values()].flatMap((box) => box.sent)).toEqual([]);
  });

  it('refuses the approval to a viewer and to another tenant', async () => {
    const byViewer = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${organizationId}/recommendations/${recommendationId}/approve`,
      headers: authorised(viewerToken),
      payload: {},
    });
    expect(byViewer.statusCode).toBe(403);
    expect(byViewer.json<{ code: string }>().code).toBe('PERMISSION_DENIED');
    expect([...mailboxes.mailboxes.values()].flatMap((box) => box.sent)).toEqual([]);

    const other = await container.tenancy.provision.execute({
      organization: { slug: 'other', name: 'Other' },
      owner: { authSubject: 'auth|other-owner' },
    });
    if (!other.ok) throw other.error;
    const issuer = container.identity.devTokenIssuer;
    if (issuer === undefined) throw new Error('issuer required');
    const otherToken = await issuer.issue({ subject: 'auth|other-owner' });
    const crossTenant = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${other.value.organization.id}/cases`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(crossTenant.statusCode).toBe(200);
    // A different tenant sees nothing of this one, even though the row exists.
    expect(crossTenant.json<{ cases: Case[] }>().cases).toEqual([]);
    const foreignCase = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${other.value.organization.id}/cases/${caseId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(foreignCase.statusCode).toBe(404);
  });

  it('sends the reply once an operator approves, and records the outcome and the audit trail', async () => {
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${organizationId}/recommendations/${recommendationId}/approve`,
      headers: authorised(operatorToken),
      payload: { note: 'Va bene, conferma la ricezione.' },
    });
    expect(approved.statusCode).toBe(200);
    const result = approved.json<{
      recommendation: { status: string; decisionNote: string };
      action: { status: string; tool: string } | null;
    }>();
    expect(result.recommendation).toMatchObject({
      status: 'approved',
      decisionNote: 'Va bene, conferma la ricezione.',
    });
    // The approval committed and handed the work to a worker; nothing has been
    // sent yet, and nothing depends on this request any more.
    expect(result.action).toBeNull();
    expect([...mailboxes.mailboxes.values()].flatMap((box) => box.sent)).toHaveLength(0);

    const worked = await queue.drain();
    expect(worked.failed).toBe(0);

    const sent = [...mailboxes.mailboxes.values()].flatMap((box) => box.sent);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: ['acquisti@officine-rossi.it'],
      subject: 'Re: Richiesta di preventivo - flange DN250',
    });
    expect(sent[0]?.text).toContain('500 pezzi');

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${organizationId}/cases/${caseId}`,
      headers: authorised(operatorToken),
    });
    const body = detail.json<{
      case: { status: string; resolution: string };
      approvals: { decision: string }[];
      actions: { status: string }[];
    }>();
    expect(body.case).toMatchObject({ status: 'resolved', resolution: 'actioned' });
    expect(body.approvals).toHaveLength(1);
    expect(body.actions).toHaveLength(1);

    const audit = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${organizationId}/audit?limit=100`,
      headers: authorised(ownerToken),
    });
    const actions = audit.json<{ entries: { action: string }[] }>().entries.map((e) => e.action);
    expect(actions).toContain('mailbox.message_ingested');
    expect(actions).toContain('tool.executed');
    expect(actions).toContain('connection.created');
    // The mailbox password never reaches the trail.
    expect(audit.body).not.toContain('demo-password');
  });

  it('is idempotent: the same message delivered twice creates no second case', async () => {
    const again = await deliver('01-rfq-cliente-noto.eml', 'e2e-nonce-000000002');
    expect(again.statusCode).toBe(200);
    expect(again.json<{ duplicate: boolean }>().duplicate).toBe(true);
    await queue.drain();
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${organizationId}/cases`,
      headers: authorised(operatorToken),
    });
    expect(listed.json<{ cases: Case[] }>().cases).toHaveLength(1);
  });

  it('refuses a replayed signature', async () => {
    const body = await readFile(resolve(MESSAGES, '06-reclamo.eml'));
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = 'e2e-nonce-000000003';
    const headers = {
      'content-type': 'message/rfc822',
      [INGESTION_HEADER_NAMES.keyId]: ingestionKeyId,
      [INGESTION_HEADER_NAMES.timestamp]: String(timestamp),
      [INGESTION_HEADER_NAMES.nonce]: nonce,
      [INGESTION_HEADER_NAMES.signature]: signIngestionRequest(
        Buffer.from(ingestionSecret, 'base64'),
        { keyId: ingestionKeyId, timestamp, nonce, body: Uint8Array.from(body) },
      ),
    };
    const url = `/v1/orgs/${organizationId}/ingest/messages`;
    const first = await app.inject({ method: 'POST', url, headers, payload: body });
    expect(first.statusCode).toBe(202);
    const replayed = await app.inject({ method: 'POST', url, headers, payload: body });
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json<{ code: string }>().code).toBe('SIGNATURE_REPLAYED');
  });

  it('records the model cost of every call against the tenant', async () => {
    const usage = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${organizationId}/ai-usage`,
      headers: authorised(ownerToken),
    });
    expect(usage.statusCode).toBe(200);
    const operations = usage
      .json<{ recent: { operation: string; useCase: string }[] }>()
      .recent.map((entry) => entry.operation);
    expect(operations).toContain('commercial_inbox.understand');
    expect(operations).toContain('commercial_inbox.draft_reply');
  });
});
