import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FixedClock } from '../../kernel/clock.js';
import { type Actor, ActorType, noExecutionContext } from '../../kernel/context.js';
import { InfrastructureError, NotFoundError } from '../../kernel/errors.js';
import { newOrganizationId, newUserId } from '../../kernel/ids.js';
import { err, ok } from '../../kernel/result.js';
import type { TenantScope } from '../../kernel/scope.js';
import type { TenantContext } from '../../kernel/tenant.js';
import { Permission, authorizer } from '../../modules/access/index.js';
import { AuditTrail, InMemoryAuditLogRepository } from '../../modules/audit/index.js';
import { digestOf } from '../shared/canonical-json.js';
import { createRequestHumanDecisionTool } from './builtin/request-human-decision.js';
import { declareNonDeterminatoTool } from './builtin/declare-non-determinato.js';
import { defineTool } from './define-tool.js';
import { ToolExecutor } from './executor.js';
import { DefaultActionPolicy, InMemoryActionPolicy, PolicyLevel, ToolEffect } from './policy.js';
import { ToolRegistry } from './registry.js';

const organizationId = newOrganizationId();
const userId = newUserId();
const scope: TenantScope = { kind: 'tenant', tenantId: organizationId };
const operator: TenantContext = {
  organizationId,
  organizationSlug: 'acme',
  userId,
  roleKey: 'operator',
};
const viewer: TenantContext = { ...operator, roleKey: 'viewer' };
const aiActor: Actor = { type: ActorType.AI, id: 'claude-haiku-4-5', onBehalfOf: userId };
const humanActor: Actor = { type: ActorType.USER, id: userId };

const sendReplyTool = defineTool({
  name: 'send_reply',
  description: 'Send an approved reply to the customer through the mailbox connector.',
  effect: ToolEffect.ACT,
  permission: Permission.AI_INVOKE,
  input: z.object({ to: z.email(), body: z.string().min(1) }),
  output: z.object({ sent: z.literal(true) }),
  handler: async () => ok({ sent: true as const }),
});

const approveTool = defineTool({
  name: 'approve_decision',
  description: 'Approve a pending decision. Only a human may call this.',
  effect: ToolEffect.ACT,
  permission: Permission.DECISIONS_APPROVE,
  input: z.object({ decisionId: z.string() }),
  output: z.object({ approved: z.literal(true) }),
  handler: async () => ok({ approved: true as const }),
});

const lookupTool = defineTool({
  name: 'lookup_customer',
  description: 'Look up a customer record by its code in the tenant records.',
  effect: ToolEffect.READ,
  permission: Permission.AI_INVOKE,
  input: z.object({ code: z.string() }),
  output: z.object({ name: z.string() }),
  handler: async (input) => {
    if (input.code === 'boom') throw new InfrastructureError('DB_DOWN', 'database unreachable');
    if (input.code === 'missing')
      return err(new NotFoundError('CUSTOMER_NOT_FOUND', 'No such customer.'));
    if (input.code === 'broken') return ok({ name: 42 as unknown as string });
    return ok({ name: `Customer ${input.code}` });
  },
});

function setup(policy = new DefaultActionPolicy()) {
  const clock = new FixedClock(new Date('2026-09-02T11:00:00.000Z'));
  const auditRepository = new InMemoryAuditLogRepository();
  const audit = new AuditTrail({ repository: auditRepository, clock, context: noExecutionContext });
  const registry = new ToolRegistry()
    .register(declareNonDeterminatoTool)
    .register(createRequestHumanDecisionTool(clock))
    .register(sendReplyTool)
    .register(approveTool)
    .register(lookupTool);
  const executor = new ToolExecutor({ registry, authorizer, policy, audit, clock });
  return { clock, auditRepository, registry, executor };
}

const asAi = { tenant: operator, actor: aiActor, scope };

describe('ToolExecutor', () => {
  it('runs a permitted tool, validates in and out, and audits the execution', async () => {
    const { executor, auditRepository } = setup();
    const result = await executor.execute(asAi, {
      name: 'lookup_customer',
      input: { code: 'C-1' },
      callId: 'toolu_1',
    });
    expect(result).toEqual({
      status: 'ok',
      tool: 'lookup_customer',
      callId: 'toolu_1',
      level: PolicyLevel.READ_ONLY,
      output: { name: 'Customer C-1' },
    });
    expect(auditRepository.entries).toHaveLength(1);
    expect(auditRepository.entries[0]).toMatchObject({
      organizationId,
      actor: aiActor,
      action: 'tool.executed',
      target: { type: 'tool', id: 'lookup_customer' },
      outcome: 'success',
      details: {
        callId: 'toolu_1',
        effect: 'read',
        permission: 'ai:invoke',
        level: 'READ_ONLY',
        policyVersion: 1,
        inputHash: digestOf({ code: 'C-1' }),
      },
    });
  });

  it('declare_non_determinato yields a structured NON_DETERMINATO and refuses vague declarations', async () => {
    const { executor } = setup();
    const declared = await executor.execute(asAi, {
      name: 'declare_non_determinato',
      input: {
        subject: 'quantity of line 2',
        unknown: ['the attachment states 250 pieces, the body states 200'],
        missingInputs: [
          { name: 'confirmed quantity', description: 'Ask the customer.', resolvableBy: 'HUMAN' },
        ],
      },
    });
    expect(declared.status).toBe('ok');
    if (declared.status !== 'ok') return;
    expect(declared.output).toMatchObject({
      kind: 'NON_DETERMINATO',
      subject: 'quantity of line 2',
    });

    const vague = await executor.execute(asAi, {
      name: 'declare_non_determinato',
      input: { subject: 'something' },
    });
    expect(vague.status).toBe('error');
    if (vague.status !== 'error') return;
    expect(vague.error.code).toBe('INVALID_NON_DETERMINATO');
  });

  it('request_human_decision produces a pending request the platform can route', async () => {
    const { executor } = setup();
    const result = await executor.execute(asAi, {
      name: 'request_human_decision',
      input: {
        subject: 'RdO ABC Srl',
        question: 'Reply asking for the drawing, or acknowledge and route to the estimator?',
        options: [{ label: 'Ask for the drawing' }, { label: 'Route to estimator' }],
        stake: 'A late answer risks the order.',
      },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.output).toMatchObject({
      kind: 'HUMAN_DECISION_REQUESTED',
      status: 'pending',
      urgency: 'normal',
      requestedAt: '2026-09-02T11:00:00.000Z',
    });
    expect(result.level).toBe(PolicyLevel.DRAFT);
  });

  it('returns structured errors for unknown tools, invalid input and domain failures', async () => {
    const { executor, auditRepository } = setup();
    const unknown = await executor.execute(asAi, { name: 'drop_tables', input: {} });
    expect(unknown.status === 'error' && unknown.error.code).toBe('UNKNOWN_TOOL');
    const invalid = await executor.execute(asAi, { name: 'lookup_customer', input: { code: 7 } });
    expect(invalid.status === 'error' && invalid.error.code).toBe('INVALID_TOOL_INPUT');
    const missing = await executor.execute(asAi, {
      name: 'lookup_customer',
      input: { code: 'missing' },
    });
    expect(missing.status === 'error' && missing.error).toMatchObject({
      code: 'CUSTOMER_NOT_FOUND',
      category: 'not_found',
    });
    expect(auditRepository.entries.map((e) => e.outcome)).toEqual([
      'failure',
      'failure',
      'failure',
    ]);
  });

  it('denies tools the role lacks and audits the denial', async () => {
    const { executor, auditRepository } = setup();
    const result = await executor.execute(
      { tenant: viewer, actor: aiActor, scope },
      { name: 'lookup_customer', input: { code: 'C-1' } },
    );
    expect(result.status === 'error' && result.error.code).toBe('PERMISSION_DENIED');
    expect(auditRepository.entries[0]?.outcome).toBe('denied');
  });

  it('never lets an AI actor use a human-only permission, whatever the role', async () => {
    const { executor } = setup(
      new InMemoryActionPolicy().setOverrides(organizationId, {
        byTool: { approve_decision: PolicyLevel.AUTO_EXECUTE },
      }),
    );
    const byAi = await executor.execute(asAi, {
      name: 'approve_decision',
      input: { decisionId: 'd-1' },
    });
    expect(byAi.status === 'error' && byAi.error.code).toBe('HUMAN_ONLY_PERMISSION');
    const byHuman = await executor.execute(
      { tenant: operator, actor: humanActor, scope },
      { name: 'approve_decision', input: { decisionId: 'd-1' } },
    );
    expect(byHuman.status).toBe('ok');
  });

  it('requires a matching approval for act tools under the default policy', async () => {
    const { executor, auditRepository } = setup();
    const input = { to: 'acquisti@example.test', body: 'Buongiorno...' };
    const withoutApproval = await executor.execute(asAi, { name: 'send_reply', input });
    expect(withoutApproval).toMatchObject({
      status: 'approval_required',
      level: 'REQUIRE_APPROVAL',
      inputHash: digestOf(input),
    });
    const wrongInput = await executor.execute(asAi, {
      name: 'send_reply',
      input,
      approval: {
        id: 'apr-1',
        toolName: 'send_reply',
        inputHash: digestOf({ ...input, body: 'x' }),
      },
    });
    expect(wrongInput.status).toBe('approval_required');
    const approved = await executor.execute(asAi, {
      name: 'send_reply',
      input,
      approval: { id: 'apr-1', toolName: 'send_reply', inputHash: digestOf(input) },
    });
    expect(approved).toMatchObject({ status: 'ok', output: { sent: true } });
    expect(auditRepository.entries.map((e) => e.outcome)).toEqual(['denied', 'denied', 'success']);
    expect(auditRepository.entries[2]?.details).toMatchObject({ approvalId: 'apr-1' });
  });

  it('applies tenant policy overrides: SUGGEST blocks an act tool, AUTO_EXECUTE runs it', async () => {
    const policy = new InMemoryActionPolicy().setOverrides(organizationId, {
      byTool: { send_reply: PolicyLevel.SUGGEST },
    });
    const { executor } = setup(policy);
    const input = { to: 'acquisti@example.test', body: 'Buongiorno' };
    const blocked = await executor.execute(asAi, { name: 'send_reply', input });
    expect(blocked).toMatchObject({ status: 'not_permitted', level: 'SUGGEST' });

    policy.setOverrides(organizationId, { byEffect: { act: PolicyLevel.AUTO_EXECUTE } });
    const executed = await executor.execute(asAi, { name: 'send_reply', input });
    expect(executed).toMatchObject({ status: 'ok', level: 'AUTO_EXECUTE' });
  });

  it('rethrows infrastructure failures and invalid tool output after auditing them', async () => {
    const { executor, auditRepository } = setup();
    await expect(
      executor.execute(asAi, { name: 'lookup_customer', input: { code: 'boom' } }),
    ).rejects.toMatchObject({ code: 'DB_DOWN' });
    await expect(
      executor.execute(asAi, { name: 'lookup_customer', input: { code: 'broken' } }),
    ).rejects.toMatchObject({ code: 'TOOL_OUTPUT_INVALID' });
    expect(auditRepository.entries.map((e) => e.outcome)).toEqual(['failure', 'failure']);
  });

  it('describes registered tools as provider-agnostic JSON Schema and refuses duplicates', () => {
    const { registry } = setup();
    const described = registry.describe();
    expect(described.map((d) => d.name)).toEqual([
      'approve_decision',
      'declare_non_determinato',
      'lookup_customer',
      'request_human_decision',
      'send_reply',
    ]);
    const lookup = described.find((d) => d.name === 'lookup_customer');
    expect(lookup?.inputSchema).toMatchObject({
      type: 'object',
      properties: { code: { type: 'string' } },
    });
    expect(() => registry.register(lookupTool)).toThrow(/already registered/);
    expect(() => defineTool({ ...lookupTool, name: 'Bad Name' })).toThrow(/snake_case/);
  });
});
