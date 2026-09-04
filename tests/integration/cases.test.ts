import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ActorType,
  type AiSystemDefinition,
  AiSystemRegistry,
  AnalyzeDocument,
  AuditTrail,
  CORE_RULES,
  type CaseDraftInput,
  CaseEngine,
  type CaseId,
  CaseProjection,
  type DocumentId,
  EntityResolver,
  EventLedger,
  FakeLlmProvider,
  ImportEntities,
  IngestDocument,
  InMemoryObjectStorage,
  type OrganizationId,
  Permission,
  PersistedActionPolicy,
  PostgresAuditLogRepository,
  PostgresCaseRepository,
  PostgresActionIntentRepository,
  PostgresCompanyProfileRepository,
  PostgresCompanyRuleRepository,
  PostgresDocumentRepository,
  PostgresDocumentTextRepository,
  PostgresEntityAliasRepository,
  PostgresEntityRepository,
  PostgresLedgerRepository,
  PostgresMembershipRepository,
  PostgresOrganizationRepository,
  PostgresPolicyOverrideRepository,
  PostgresProjectionCheckpointRepository,
  PostgresTerminologyRepository,
  PostgresTransactionRunner,
  PostgresUserRepository,
  ProjectionRunner,
  ProvisionOrganization,
  RuleRegistry,
  type TenantContext,
  ToolEffect,
  ToolExecutor,
  ToolRegistry,
  WorkspaceConfiguration,
  authorizer,
  clientOf,
  defaultTextExtractor,
  defineTool,
  err,
  evidenceForQuote,
  noExecutionContext,
  noopLogger,
  ok,
  systemClock,
} from '@dolmir/core';

import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

/**
 * The whole chain on real infrastructure: INGEST → UNDERSTAND → RESOLVE →
 * REASON → EVIDENCE → RECOMMEND → HUMAN APPROVAL → ACTION → OUTCOME, with a
 * scripted AI System standing in for a real one. Proves the Core contract a
 * system builds on, tenant isolation of cases, the runtime role's limits and
 * the rebuild of the read model from the ledger alone.
 */

const sent: { to: string; body: string }[] = [];
const sendReply = defineTool({
  name: 'send_reply',
  description: 'Send an approved reply to the customer through the mailbox connector.',
  effect: ToolEffect.ACT,
  permission: Permission.AI_INVOKE,
  input: z.object({ to: z.email(), body: z.string().min(1) }),
  output: z.object({ messageId: z.string() }),
  handler: async (input) => {
    sent.push(input);
    return ok({ messageId: `msg-${String(sent.length)}` });
  },
});

const CUSTOMER_EMAIL = 'acquisti@officine-rossi.it';

const testSystem: AiSystemDefinition = {
  key: 'test_inbox',
  name: 'Scripted inbox system',
  version: 1,
  documentKinds: ['email'],
  tools: [sendReply],
  rules: [],
  async analyze(input, context) {
    const evidence = evidenceForQuote(input.document.id, input.texts, 'preventivo per 250 flange');
    if (!evidence.ok) return err(evidence.error);
    const customer = await context.entities.resolve(context.scope, {
      kind: 'customer',
      email: CUSTOMER_EMAIL,
    });
    const draft: CaseDraftInput = {
      kind: 'quote_request',
      title: 'Richiesta di preventivo: 250 flange',
      summary: `${input.company.profile.legalName} ha ricevuto una richiesta di preventivo per 250 flange.`,
      priority: 'high',
      determination: 'READY_FOR_REVIEW',
      subjects:
        customer.kind === 'RESOLVED'
          ? [{ type: 'customer', id: customer.match.entity.id, label: customer.match.entity.name }]
          : [],
      findings: [
        {
          statement: 'The customer asks for a quote for 250 flanges.',
          status: 'OBSERVATION',
          evidence: [evidence.value],
          tags: ['quantity'],
        },
      ],
      recommendations: [
        {
          tool: 'send_reply',
          input: {
            to: CUSTOMER_EMAIL,
            body: 'Buongiorno, grazie della richiesta: inviamo il preventivo entro domani.',
          },
          rationale: 'Quote requests receive an acknowledgement within the response SLA.',
        },
      ],
    };
    return ok(draft);
  },
};

describe('cases on PostgreSQL', () => {
  let db: TestDatabase;
  let transactions: PostgresTransactionRunner;
  let ownerTransactions: PostgresTransactionRunner;
  let orgA: OrganizationId;
  let orgB: OrganizationId;
  let tenantA: TenantContext;
  let tenantB: TenantContext;
  let audit: AuditTrail;
  let ledger: EventLedger;
  let workspace: WorkspaceConfiguration;
  let engine: CaseEngine;
  let analyze: AnalyzeDocument;
  let ingest: IngestDocument;
  const ledgerRepository = new PostgresLedgerRepository();
  const cases = new PostgresCaseRepository();
  const actionIntents = new PostgresActionIntentRepository();
  const projection = new CaseProjection(cases);
  const documents = new PostgresDocumentRepository();
  const texts = new PostgresDocumentTextRepository();
  const actor = { type: ActorType.SERVICE, id: 'test-ingest' };

  let documentId: DocumentId;
  let caseId: CaseId;
  let recommendationId: string;

  const email = (sourceRef: string) => ({
    tenantId: orgA,
    kind: 'email' as const,
    sourceKind: 'EMAIL' as const,
    sourceRef,
    body: new TextEncoder().encode(
      '<p>Buongiorno,<br>chiediamo un <b>preventivo per 250 flange</b> tornite in S355.</p>',
    ),
    contentType: 'text/html; charset=utf-8',
    receivedAt: new Date('2026-09-03T08:00:00.000Z'),
    metadata: { subject: 'Preventivo flange', from: CUSTOMER_EMAIL },
    actor,
    recordedBy: 'test',
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    transactions = new PostgresTransactionRunner(db.appPool, noopLogger);
    ownerTransactions = new PostgresTransactionRunner(db.ownerPool, noopLogger);
    audit = new AuditTrail({
      repository: new PostgresAuditLogRepository(),
      clock: systemClock,
      context: noExecutionContext,
    });
    const organizations = new PostgresOrganizationRepository();
    const memberships = new PostgresMembershipRepository();
    const provision = new ProvisionOrganization({
      transactions,
      organizations,
      users: new PostgresUserRepository(),
      memberships,
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
    tenantA = {
      organizationId: orgA,
      organizationSlug: 'a',
      userId: a.value.owner.id,
      roleKey: 'owner',
    };
    tenantB = {
      organizationId: orgB,
      organizationSlug: 'b',
      userId: b.value.owner.id,
      roleKey: 'owner',
    };

    ledger = new EventLedger({ repository: ledgerRepository, context: noExecutionContext });
    const ruleRegistry = new RuleRegistry();
    for (const rule of CORE_RULES) ruleRegistry.register(rule);
    const overrides = new PostgresPolicyOverrideRepository();
    workspace = new WorkspaceConfiguration({
      profiles: new PostgresCompanyProfileRepository(),
      rules: new PostgresCompanyRuleRepository(),
      terminology: new PostgresTerminologyRepository(),
      policyOverrides: overrides,
      ruleRegistry,
      audit,
      clock: systemClock,
    });
    const policy = new PersistedActionPolicy({ transactions, overrides });
    const tools = new ToolRegistry().register(sendReply);
    const executor = new ToolExecutor({
      registry: tools,
      authorizer,
      policy,
      audit,
      clock: systemClock,
    });
    engine = new CaseEngine({
      transactions,
      ledger,
      cases,
      intents: actionIntents,
      projection,
      tools,
      policy,
      executor,
      authorizer,
      memberships,
      clock: systemClock,
    });
    ingest = new IngestDocument({
      transactions,
      documents,
      texts,
      storage: new InMemoryObjectStorage(),
      extractor: defaultTextExtractor(),
      ledger,
      clock: systemClock,
    });
    const entities = new PostgresEntityRepository();
    const aliases = new PostgresEntityAliasRepository();
    const imported = await new ImportEntities({ transactions, entities, aliases, audit }).execute(
      orgA,
      { type: ActorType.USER, id: tenantA.userId },
      {
        source: 'test',
        rows: [
          {
            kind: 'customer',
            name: 'Officine Meccaniche Rossi S.r.l.',
            code: 'C0042',
            email: CUSTOMER_EMAIL,
          },
        ],
      },
    );
    if (!imported.ok) throw imported.error;
    analyze = new AnalyzeDocument({
      transactions,
      documents,
      texts,
      organizations,
      workspace,
      systems: new AiSystemRegistry().register(testSystem),
      cases,
      engine,
      llm: new FakeLlmProvider(),
      entities: new EntityResolver({ entities, aliases }),
      clock: systemClock,
    });
  });

  afterAll(async () => {
    await db.drop();
  });

  it('ingests, analyses and opens a case with evidence, a resolved subject and a recommendation awaiting approval', async () => {
    const ingested = await ingest.execute(email('imap:acquisti:1'));
    if (!ingested.ok) throw ingested.error;
    documentId = ingested.value.document.id;

    const report = await analyze.execute(orgA, documentId);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.failed).toEqual([]);
    expect(report.value.opened).toHaveLength(1);
    const opened = report.value.opened[0];
    if (opened === undefined) return;
    caseId = opened.case.id;
    expect(opened.case).toMatchObject({
      organizationId: orgA,
      systemKey: 'test_inbox',
      systemVersion: 1,
      kind: 'quote_request',
      status: 'awaiting_approval',
      priority: 'high',
      determination: 'READY_FOR_REVIEW',
      summary: 'Alfa Meccanica ha ricevuto una richiesta di preventivo per 250 flange.',
      version: 3,
    });
    expect(opened.case.subjects.map((s) => [s.type, s.label])).toEqual([
      ['document', 'email'],
      ['customer', 'Officine Meccaniche Rossi S.r.l.'],
    ]);
    expect(opened.findings[0]).toMatchObject({
      statement: 'The customer asks for a quote for 250 flanges.',
      status: 'OBSERVATION',
      tags: ['quantity'],
    });
    expect(opened.findings[0]?.evidence[0]).toMatchObject({
      kind: 'DOCUMENT_SPAN',
      sourceRef: `document:${documentId}`,
      content: 'preventivo per 250 flange',
    });
    const recommendation = opened.recommendations[0];
    if (recommendation === undefined) throw new Error('no recommendation');
    recommendationId = recommendation.id;
    expect(recommendation).toMatchObject({
      tool: 'send_reply',
      level: 'REQUIRE_APPROVAL',
      status: 'proposed',
      input: { to: CUSTOMER_EMAIL },
    });

    const again = await analyze.execute(orgA, documentId);
    expect(again.ok && again.value).toMatchObject({
      opened: [],
      skipped: [{ systemKey: 'test_inbox', reason: 'already_analyzed' }],
    });

    const attention = await transactions.withTenant(orgA, (scope) =>
      cases.listCases(scope, { limit: 10, statuses: ['open', 'awaiting_approval'] }),
    );
    expect(attention.map((c) => c.id)).toEqual([caseId]);
  });

  it('runs the approved recommendation with the approver permissions, records the action and settles the case', async () => {
    const foreign = await engine.decide(tenantB, recommendationId, 'approved', null);
    expect(!foreign.ok && foreign.error.code).toBe('RECOMMENDATION_NOT_FOUND');

    const approved = await engine.decide(tenantA, recommendationId, 'approved', 'Va bene, invia.');
    expect(approved.ok && approved.value).toMatchObject({
      status: 'approved',
      decidedBy: tenantA.userId,
      decisionNote: 'Va bene, invia.',
    });

    const executed = await engine.execute(orgA, recommendationId);
    expect(executed.ok && executed.value).toMatchObject({
      status: 'succeeded',
      tool: 'send_reply',
      result: { messageId: 'msg-1' },
    });
    expect(sent).toEqual([
      {
        to: CUSTOMER_EMAIL,
        body: 'Buongiorno, grazie della richiesta: inviamo il preventivo entro domani.',
      },
    ]);

    const detail = await transactions.withTenant(orgA, (scope) => engine.detail(scope, caseId));
    expect(detail?.case).toMatchObject({ status: 'resolved', resolution: 'actioned', version: 7 });
    expect(detail?.recommendations[0]?.status).toBe('executed');
    expect(detail?.approvals).toHaveLength(1);
    expect(detail?.actions).toHaveLength(1);

    const stream = await transactions.withTenant(orgA, (scope) =>
      ledger.readStream(scope, { type: 'case', id: caseId }),
    );
    expect(stream.map((e) => e.eventType)).toEqual([
      'CaseOpened',
      'FindingRecorded',
      'RecommendationProposed',
      'RecommendationApproved',
      'ActionExecuted',
      'OutcomeRecorded',
      'CaseResolved',
    ]);
    expect(stream[0]?.provenance).toMatchObject({
      sourceKind: 'AI',
      sourceRef: 'imap:acquisti:1',
      actor: { type: 'AI', id: 'test_inbox@1' },
      evidenceRefs: [`document:${documentId}`],
    });
    expect(stream[3]?.provenance.actor).toEqual({ type: 'USER', id: tenantA.userId });

    const entries = await transactions.withTenant(orgA, (scope) =>
      audit.list(scope, { limit: 50 }),
    );
    const toolAudit = entries.find((e) => e.action === 'tool.executed');
    expect(toolAudit).toMatchObject({
      outcome: 'success',
      actor: { type: 'SYSTEM', id: 'case_engine', onBehalfOf: tenantA.userId },
    });
    expect(toolAudit?.details).toMatchObject({ approvalId: detail?.approvals[0]?.id });
  });

  it('auto-executes when the company policy allows it, straight after analysis', async () => {
    const override = await transactions.withTenant(orgA, (scope) =>
      workspace.setPolicyOverride(
        scope,
        tenantA,
        'tool',
        'send_reply',
        'AUTO_EXECUTE',
        'Acknowledgements may go out without review.',
      ),
    );
    expect(override.ok).toBe(true);

    const ingested = await ingest.execute(email('imap:acquisti:2'));
    if (!ingested.ok) throw ingested.error;
    const report = await analyze.execute(orgA, ingested.value.document.id);
    if (!report.ok) throw report.error;
    const opened = report.value.opened[0];
    if (opened === undefined) throw new Error('no case opened');
    expect(opened.recommendations[0]?.level).toBe('AUTO_EXECUTE');
    expect(sent).toHaveLength(2);
    const detail = await transactions.withTenant(orgA, (scope) =>
      engine.detail(scope, opened.case.id),
    );
    expect(detail?.case).toMatchObject({ status: 'resolved', resolution: 'actioned' });
    expect(detail?.approvals).toEqual([]);
    expect(detail?.actions[0]).toMatchObject({ status: 'succeeded' });

    // Other tenants keep the default: approval required.
    const inB = await new PersistedActionPolicy({
      transactions,
      overrides: new PostgresPolicyOverrideRepository(),
    }).resolve(orgB, { name: 'send_reply', effect: 'act' });
    expect(inB.level).toBe('REQUIRE_APPROVAL');
  });

  it('hides cases from other tenants and lets the runtime role neither rewrite decisions nor delete', async () => {
    const seenByB = await transactions.withTenant(orgB, async (scope) => ({
      found: await cases.findCase(scope, caseId),
      listed: await cases.listCases(scope, { limit: 10 }),
      detail: await engine.detail(scope, caseId),
      recommendations: await cases.listRecommendations(scope, caseId),
    }));
    expect(seenByB).toEqual({
      found: undefined,
      listed: [],
      detail: undefined,
      recommendations: [],
    });
    const resolveByB = await engine.resolve(tenantB, caseId, 'dismissed', null);
    expect(!resolveByB.ok && resolveByB.error.code).toBe('CASE_NOT_FOUND');

    const attempt = (sql: string) =>
      transactions.withTenant(orgA, (scope) => clientOf(scope).query(sql));
    await expect(
      attempt("UPDATE public.approvals SET decision = 'rejected'"),
    ).rejects.toMatchObject({
      category: 'forbidden',
    });
    await expect(attempt("UPDATE public.actions SET status = 'failed'")).rejects.toMatchObject({
      category: 'forbidden',
    });
    await expect(attempt("UPDATE public.case_findings SET statement = 'x'")).rejects.toMatchObject({
      category: 'forbidden',
    });
    for (const table of ['cases', 'case_findings', 'recommendations', 'approvals', 'actions']) {
      await expect(attempt(`DELETE FROM public.${table}`)).rejects.toMatchObject({
        category: 'forbidden',
      });
    }
  });

  it('rebuilds the whole read model from the ledger with the owner role and lands on the same state', async () => {
    const snapshot = () =>
      ownerTransactions.withSystemScope('snapshot', async (scope) => {
        const rows = async (table: string): Promise<Record<string, unknown>[]> =>
          (
            await clientOf(scope).query<Record<string, unknown>>(
              `SELECT * FROM public.${table} ORDER BY id`,
            )
          ).rows;
        return {
          cases: await rows('cases'),
          findings: await rows('case_findings'),
          recommendations: await rows('recommendations'),
          approvals: await rows('approvals'),
          actions: await rows('actions'),
        };
      });
    const before = await snapshot();
    expect(before.cases).toHaveLength(2);
    expect(before.approvals).toHaveLength(1);
    expect(before.actions).toHaveLength(2);

    const runner = new ProjectionRunner({
      transactions: ownerTransactions,
      ledger: ledgerRepository,
      checkpoints: new PostgresProjectionCheckpointRepository(),
    });
    const report = await runner.rebuild(projection);
    const total = await ownerTransactions.withSystemScope('count', async (scope) => {
      const result = await clientOf(scope).query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.ledger_events',
      );
      return result.rows[0]?.n ?? 0;
    });
    expect(report.processed).toBe(total);
    expect(await snapshot()).toEqual(before);

    const checkpoint = await db.ownerPool.query<{ n: number }>(
      "SELECT last_global_sequence::int AS n FROM public.projection_checkpoints WHERE projection_name = 'cases'",
    );
    expect(checkpoint.rows[0]).toEqual({ n: report.lastGlobalSequence });
  });
});
