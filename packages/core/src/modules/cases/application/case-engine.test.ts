import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FixedClock } from '../../../kernel/clock.js';
import { ActorType, noExecutionContext } from '../../../kernel/context.js';
import { InfrastructureError } from '../../../kernel/errors.js';
import { newOrganizationId, newUserId } from '../../../kernel/ids.js';
import { err, ok } from '../../../kernel/result.js';
import type { TenantContext } from '../../../kernel/tenant.js';
import { PolicyLevel, ToolEffect } from '../../../kernel/action-policy.js';
import { InMemoryActionPolicy, ToolExecutor, ToolRegistry, defineTool } from '../../../ai/index.js';
import { Permission, authorizer } from '../../access/index.js';
import { AuditTrail, InMemoryAuditLogRepository } from '../../audit/index.js';
import {
  EventLedger,
  InMemoryLedgerRepository,
  InMemoryProjectionCheckpointRepository,
  ProjectionRunner,
} from '../../ledger/index.js';
import {
  InMemoryMembershipRepository,
  InMemoryTenancyStore,
  InMemoryTransactionRunner,
} from '../../tenancy/index.js';
import { InMemoryCaseRepository } from '../adapters/memory/in-memory-case-repository.js';
import { CaseEngine } from './case-engine.js';
import { CaseProjection } from './case-projection.js';

const organizationId = newOrganizationId();
const operatorId = newUserId();
const viewerId = newUserId();
const operator: TenantContext = {
  organizationId,
  organizationSlug: 'acme',
  userId: operatorId,
  roleKey: 'operator',
};
const viewer: TenantContext = {
  organizationId,
  organizationSlug: 'acme',
  userId: viewerId,
  roleKey: 'viewer',
};

const sent: { to: string; body: string }[] = [];
const sendReply = defineTool({
  name: 'send_reply',
  description: 'Send an approved reply to the customer through the mailbox connector.',
  effect: ToolEffect.ACT,
  permission: Permission.AI_INVOKE,
  input: z.object({ to: z.email(), body: z.string().min(1) }),
  output: z.object({ messageId: z.string() }),
  handler: async (input) => {
    if (input.body === 'boom')
      return err(new InfrastructureError('SMTP_DOWN', 'mail server unreachable'));
    sent.push(input);
    return ok({ messageId: `msg-${sent.length}` });
  },
});
const lookup = defineTool({
  name: 'lookup_customer',
  description: 'Look up a customer by code in the tenant records.',
  effect: ToolEffect.READ,
  permission: Permission.AI_INVOKE,
  input: z.object({ code: z.string() }),
  output: z.object({ name: z.string() }),
  handler: async () => ok({ name: 'x' }),
});

function setup() {
  const clock = new FixedClock(new Date('2026-09-03T11:00:00.000Z'));
  const transactions = new InMemoryTransactionRunner();
  const tenancy = new InMemoryTenancyStore(clock);
  const memberships = new InMemoryMembershipRepository(tenancy);
  tenancy.memberships.push(
    {
      organizationId,
      userId: operatorId,
      roleKey: 'operator',
      status: 'active',
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
    {
      organizationId,
      userId: viewerId,
      roleKey: 'viewer',
      status: 'active',
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
  );
  const auditRepository = new InMemoryAuditLogRepository();
  const audit = new AuditTrail({ repository: auditRepository, clock, context: noExecutionContext });
  const ledgerRepository = new InMemoryLedgerRepository(clock);
  const ledger = new EventLedger({ repository: ledgerRepository, context: noExecutionContext });
  const cases = new InMemoryCaseRepository();
  const projection = new CaseProjection(cases);
  const tools = new ToolRegistry().register(sendReply).register(lookup);
  const policy = new InMemoryActionPolicy();
  const executor = new ToolExecutor({ registry: tools, authorizer, policy, audit, clock });
  const engine = new CaseEngine({
    transactions,
    ledger,
    cases,
    projection,
    tools,
    policy,
    executor,
    authorizer,
    memberships,
    clock,
  });
  return {
    clock,
    transactions,
    auditRepository,
    ledgerRepository,
    cases,
    projection,
    policy,
    engine,
  };
}

const draft = {
  kind: 'quote_request',
  title: 'RdO da Officine Rossi: 250 flange',
  summary: 'Richiesta di preventivo con quantità e materiale; manca il disegno.',
  priority: 'high' as const,
  determination: 'READY_FOR_REVIEW' as const,
  findings: [
    {
      statement: 'The customer asks for 250 turned flanges in S355',
      status: 'OBSERVATION' as const,
      evidence: [
        {
          kind: 'DOCUMENT_SPAN' as const,
          sourceRef: 'document:d1',
          content: '250 flange tornite in acciaio S355',
          locator: { part: 0, start: 10, end: 44 },
        },
      ],
      tags: ['quantity'],
    },
  ],
  recommendations: [
    {
      tool: 'send_reply',
      input: {
        to: 'acquisti@officine-rossi.it',
        body: 'Buongiorno, per quotare ci serve il disegno.',
      },
      rationale: 'The drawing is missing.',
    },
  ],
};
const provenance = {
  systemKey: 'commercial_inbox',
  systemVersion: 1,
  sourceRef: 'imap:acquisti:1',
};

describe('CaseEngine', () => {
  it('opens a case from a draft: events on the ledger, read model projected, approval required by default', async () => {
    const { engine, ledgerRepository, cases } = setup();
    const opened = await engine.openCase(organizationId, draft, provenance);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.case).toMatchObject({
      systemKey: 'commercial_inbox',
      kind: 'quote_request',
      status: 'awaiting_approval',
      priority: 'high',
      determination: 'READY_FOR_REVIEW',
      version: 3,
    });
    expect(opened.value.findings).toHaveLength(1);
    expect(opened.value.recommendations[0]).toMatchObject({
      tool: 'send_reply',
      level: 'REQUIRE_APPROVAL',
      status: 'proposed',
    });
    expect(ledgerRepository.events.map((e) => e.eventType)).toEqual([
      'CaseOpened',
      'FindingRecorded',
      'RecommendationProposed',
    ]);
    expect(ledgerRepository.events[0]?.provenance).toMatchObject({
      sourceKind: 'AI',
      actor: { type: 'AI', id: 'commercial_inbox@1' },
    });
    expect(cases.cases.size).toBe(1);
  });

  it('refuses drafts whose recommendations name unknown tools, invalid input or non-action tools', async () => {
    const { engine } = setup();
    const unknown = await engine.openCase(
      organizationId,
      { ...draft, recommendations: [{ tool: 'delete_all', input: {}, rationale: 'x' }] },
      provenance,
    );
    expect(!unknown.ok && unknown.error.code).toBe('UNKNOWN_RECOMMENDATION_TOOL');
    const invalid = await engine.openCase(
      organizationId,
      {
        ...draft,
        recommendations: [
          { tool: 'send_reply', input: { to: 'not-an-email', body: '' }, rationale: 'x' },
        ],
      },
      provenance,
    );
    expect(!invalid.ok && invalid.error.code).toBe('INVALID_RECOMMENDATION_INPUT');
    const read = await engine.openCase(
      organizationId,
      {
        ...draft,
        recommendations: [{ tool: 'lookup_customer', input: { code: 'C1' }, rationale: 'x' }],
      },
      provenance,
    );
    expect(!read.ok && read.error.code).toBe('RECOMMENDATION_NOT_AN_ACTION');
    const vague = await engine.openCase(
      organizationId,
      { ...draft, determination: 'NON_DETERMINATO' },
      provenance,
    );
    expect(!vague.ok && vague.error.code).toBe('INVALID_CASE_DRAFT');
  });

  it('approves, executes with the approver permissions and settles the case as actioned', async () => {
    const { engine, transactions, auditRepository } = setup();
    sent.length = 0;
    const opened = await engine.openCase(organizationId, draft, provenance);
    if (!opened.ok) throw opened.error;
    const recommendationId = opened.value.recommendations[0]!.id;

    const byViewer = await engine.decide(viewer, recommendationId, 'approved', null);
    expect(!byViewer.ok && byViewer.error.code).toBe('PERMISSION_DENIED');

    const approved = await engine.decide(operator, recommendationId, 'approved', 'Va bene, invia.');
    expect(approved.ok && approved.value).toMatchObject({
      status: 'approved',
      decidedBy: operatorId,
      decisionNote: 'Va bene, invia.',
    });
    const twice = await engine.decide(operator, recommendationId, 'approved', null);
    expect(!twice.ok && twice.error.code).toBe('RECOMMENDATION_ALREADY_DECIDED');

    const executed = await engine.execute(organizationId, recommendationId);
    expect(executed.ok && executed.value).toMatchObject({
      status: 'succeeded',
      result: { messageId: 'msg-1' },
      tool: 'send_reply',
    });
    expect(sent).toEqual([
      { to: 'acquisti@officine-rossi.it', body: 'Buongiorno, per quotare ci serve il disegno.' },
    ]);

    const detail = await transactions.withTenant(organizationId, (scope) =>
      engine.detail(scope, opened.value.case.id),
    );
    expect(detail?.case).toMatchObject({ status: 'resolved', resolution: 'actioned' });
    expect(detail?.recommendations[0]?.status).toBe('executed');
    expect(detail?.approvals).toHaveLength(1);
    expect(detail?.actions).toHaveLength(1);
    const toolAudit = auditRepository.entries.find((e) => e.action === 'tool.executed');
    expect(toolAudit).toMatchObject({
      outcome: 'success',
      actor: { type: ActorType.SYSTEM, id: 'case_engine', onBehalfOf: operatorId },
    });
    expect(toolAudit?.details).toMatchObject({ approvalId: detail?.approvals[0]?.id });
  });

  it('rejecting the only recommendation dismisses the case; failed actions keep it open', async () => {
    const { engine, transactions } = setup();
    const rejected = await engine.openCase(organizationId, draft, provenance);
    if (!rejected.ok) throw rejected.error;
    const decision = await engine.decide(
      operator,
      rejected.value.recommendations[0]!.id,
      'rejected',
      'Non rispondiamo.',
    );
    expect(decision.ok && decision.value.status).toBe('rejected');
    const dismissed = await transactions.withTenant(organizationId, (scope) =>
      engine.detail(scope, rejected.value.case.id),
    );
    expect(dismissed?.case).toMatchObject({ status: 'dismissed', resolution: 'dismissed' });
    const cannotExecute = await engine.execute(
      organizationId,
      rejected.value.recommendations[0]!.id,
    );
    expect(!cannotExecute.ok && cannotExecute.error.code).toBe('RECOMMENDATION_NOT_EXECUTABLE');

    const failing = await engine.openCase(
      organizationId,
      {
        ...draft,
        recommendations: [
          { tool: 'send_reply', input: { to: 'a@b.test', body: 'boom' }, rationale: 'x' },
        ],
      },
      provenance,
    );
    if (!failing.ok) throw failing.error;
    await engine.decide(operator, failing.value.recommendations[0]!.id, 'approved', null);
    await expect(
      engine.execute(organizationId, failing.value.recommendations[0]!.id),
    ).rejects.toMatchObject({ code: 'SMTP_DOWN' });
  });

  it('auto-executes when the company policy says so and blocks execution when it says SUGGEST', async () => {
    const { engine, policy } = setup();
    sent.length = 0;
    policy.setOverrides(organizationId, { byTool: { send_reply: PolicyLevel.AUTO_EXECUTE } });
    const auto = await engine.openCase(organizationId, draft, provenance);
    if (!auto.ok) throw auto.error;
    expect(auto.value.case.status).toBe('open');
    expect(auto.value.recommendations[0]?.level).toBe('AUTO_EXECUTE');
    const executed = await engine.execute(organizationId, auto.value.recommendations[0]!.id);
    expect(executed.ok && executed.value.status).toBe('succeeded');
    expect(sent).toHaveLength(1);

    policy.setOverrides(organizationId, { byTool: { send_reply: PolicyLevel.SUGGEST } });
    const suggested = await engine.openCase(organizationId, draft, provenance);
    if (!suggested.ok) throw suggested.error;
    const decision = await engine.decide(
      operator,
      suggested.value.recommendations[0]!.id,
      'approved',
      null,
    );
    expect(!decision.ok && decision.error.code).toBe('RECOMMENDATION_NOT_EXECUTABLE');
  });

  it('resolves informational cases by hand and rebuilds the read model from the ledger alone', async () => {
    const { engine, transactions, cases, projection, ledgerRepository, clock } = setup();
    const informational = await engine.openCase(
      organizationId,
      { ...draft, recommendations: [] },
      provenance,
    );
    if (!informational.ok) throw informational.error;
    const cannotView = await engine.resolve(viewer, informational.value.case.id, 'dismissed', null);
    expect(!cannotView.ok && cannotView.error.code).toBe('PERMISSION_DENIED');
    const resolved = await engine.resolve(
      operator,
      informational.value.case.id,
      'resolved_manually',
      'Gestito a telefono.',
    );
    expect(resolved.ok && resolved.value).toMatchObject({
      status: 'resolved',
      resolution: 'resolved_manually',
    });

    const acted = await engine.openCase(organizationId, draft, provenance);
    if (!acted.ok) throw acted.error;
    await engine.decide(operator, acted.value.recommendations[0]!.id, 'approved', null);
    await engine.execute(organizationId, acted.value.recommendations[0]!.id);

    const snapshot = JSON.stringify([...cases.cases.values()].map((c) => ({ ...c, id: c.id })));
    const runner = new ProjectionRunner({
      transactions,
      ledger: ledgerRepository,
      checkpoints: new InMemoryProjectionCheckpointRepository(),
    });
    const report = await runner.rebuild(projection);
    expect(report.processed).toBe(ledgerRepository.events.length);
    expect(JSON.stringify([...cases.cases.values()])).toBe(snapshot);
    expect(cases.approvals).toHaveLength(1);
    expect(cases.actions).toHaveLength(1);
    expect(clock.now()).toBeInstanceOf(Date);
  });
});
