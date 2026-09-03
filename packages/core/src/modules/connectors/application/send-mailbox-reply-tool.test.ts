import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../../kernel/clock.js';
import { ActorType, noExecutionContext } from '../../../kernel/context.js';
import { newConnectionId, newOrganizationId, newUserId } from '../../../kernel/ids.js';
import type { TenantContext } from '../../../kernel/tenant.js';
import { PolicyLevel } from '../../../kernel/action-policy.js';
import { InMemoryActionPolicy, ToolExecutor, ToolRegistry, digestOf } from '../../../ai/index.js';
import { authorizer } from '../../access/index.js';
import { AuditTrail, InMemoryAuditLogRepository } from '../../audit/index.js';
import { InMemoryTransactionRunner } from '../../tenancy/index.js';
import {
  FAKE_MAILBOX_PROVIDER,
  FakeMailboxFactory,
} from '../adapters/memory/fake-mailbox-connector.js';
import {
  InMemoryConnectionRepository,
  InMemoryConnectionStore,
} from '../adapters/memory/in-memory-connection-repositories.js';
import { CredentialCipher } from '../domain/credential-cipher.js';
import { ConnectionSecrets } from './connection-secrets.js';
import { ManageConnections } from './manage-connections.js';
import {
  SEND_MAILBOX_REPLY_TOOL,
  SendMailboxReplyInputSchema,
  createSendMailboxReplyTool,
} from './send-mailbox-reply-tool.js';

const orgA = newOrganizationId();
const orgB = newOrganizationId();
const ownerA: TenantContext = {
  organizationId: orgA,
  organizationSlug: 'a',
  userId: newUserId(),
  roleKey: 'owner',
};
const operatorA: TenantContext = { ...ownerA, userId: newUserId(), roleKey: 'operator' };
const viewerA: TenantContext = { ...ownerA, userId: newUserId(), roleKey: 'viewer' };
const ownerB: TenantContext = {
  organizationId: orgB,
  organizationSlug: 'b',
  userId: newUserId(),
  roleKey: 'owner',
};

async function setup() {
  const clock = new FixedClock(new Date('2026-09-03T12:00:00.000Z'));
  const transactions = new InMemoryTransactionRunner();
  const store = new InMemoryConnectionStore(clock);
  const connections = new InMemoryConnectionRepository(store);
  const cipher = CredentialCipher.fromBase64(CredentialCipher.generateKeyBase64());
  const auditRepository = new InMemoryAuditLogRepository();
  const audit = new AuditTrail({ repository: auditRepository, clock, context: noExecutionContext });
  const factory = new FakeMailboxFactory();
  const manage = new ManageConnections({
    transactions,
    connections,
    cipher,
    authorizer,
    audit,
    clock,
  });
  const mailbox = await manage.create(ownerA, {
    capability: 'mailbox',
    provider: FAKE_MAILBOX_PROVIDER,
    displayName: 'Vendite',
    settings: { mailbox: 'INBOX' },
    credentials: { user: 'vendite@alfa.test', pass: 'secret-app-password' },
  });
  if (!mailbox.ok) throw mailbox.error;
  const endpoint = await manage.issueIngestionKey(ownerA, 'forwarder');
  if (!endpoint.ok) throw endpoint.error;
  const inTenantB = await manage.create(ownerB, {
    capability: 'mailbox',
    provider: FAKE_MAILBOX_PROVIDER,
    displayName: 'Vendite B',
    settings: {},
    credentials: { user: 'b@b.test', pass: 'b-password' },
  });
  if (!inTenantB.ok) throw inTenantB.error;

  const tool = createSendMailboxReplyTool({
    connections,
    secrets: new ConnectionSecrets({ connections, cipher }),
    factory,
    clock,
  });
  const registry = new ToolRegistry().register(tool);
  const policy = new InMemoryActionPolicy();
  const executor = new ToolExecutor({ registry, authorizer, policy, audit, clock });
  return {
    clock,
    transactions,
    factory,
    manage,
    executor,
    policy,
    auditRepository,
    tool,
    connectionId: mailbox.value.id,
    endpointId: endpoint.value.connection.id,
    foreignConnectionId: inTenantB.value.id,
  };
}

const reply = (connectionId: string) => ({
  connectionId,
  to: ['acquisti@officine-rossi.it'],
  subject: 'Re: Richiesta di preventivo',
  body: 'Buongiorno, confermiamo la ricezione della richiesta.',
  inReplyTo: 'm-1@officine-rossi.it',
});

/** The approval covers the exact validated input, defaults included, as the executor requires. */
const approvalFor = (input: unknown) => ({
  id: '0192b4c1-0000-7000-8000-000000000001',
  toolName: SEND_MAILBOX_REPLY_TOOL,
  inputHash: digestOf(SendMailboxReplyInputSchema.parse(input)),
});

describe('send_mailbox_reply', () => {
  it('is an act tool that the platform refuses to run without an approval', async () => {
    const { executor, transactions, factory, connectionId, tool } = await setup();
    expect(tool.effect).toBe('act');
    const outcome = await transactions.withTenant(orgA, (scope) =>
      executor.execute(
        { tenant: operatorA, actor: { type: ActorType.AI, id: 'commercial_inbox@1' }, scope },
        { name: SEND_MAILBOX_REPLY_TOOL, input: reply(connectionId), callId: 'c1' },
      ),
    );
    expect(outcome.status).toBe('approval_required');
    expect(factory.for(connectionId).sent).toEqual([]);
  });

  it('sends through the tenant mailbox once an approval is presented, and closes the connector', async () => {
    const { executor, transactions, factory, connectionId, auditRepository } = await setup();
    const input = reply(connectionId);
    const outcome = await transactions.withTenant(orgA, (scope) =>
      executor.execute(
        {
          tenant: operatorA,
          actor: { type: ActorType.SYSTEM, id: 'case_engine', onBehalfOf: operatorA.userId },
          scope,
        },
        {
          name: SEND_MAILBOX_REPLY_TOOL,
          input,
          callId: 'c2',
          approval: approvalFor(input),
        },
      ),
    );
    expect(outcome.status).toBe('ok');
    const mailbox = factory.for(connectionId);
    expect(mailbox.sent).toEqual([
      {
        to: ['acquisti@officine-rossi.it'],
        subject: 'Re: Richiesta di preventivo',
        text: 'Buongiorno, confermiamo la ricezione della richiesta.',
        inReplyTo: 'm-1@officine-rossi.it',
      },
    ]);
    expect(mailbox.closed).toBe(true);
    const entry = auditRepository.entries.find((item) => item.action === 'tool.executed');
    expect(entry).toMatchObject({ outcome: 'success' });
    // The audit trail records the call, never the mailbox password.
    expect(JSON.stringify(auditRepository.entries)).not.toContain('secret-app-password');
  });

  it('cannot reach another tenant mailbox, even with a correct connection id', async () => {
    const { executor, transactions, foreignConnectionId, factory } = await setup();
    const input = reply(foreignConnectionId);
    const outcome = await transactions.withTenant(orgA, (scope) =>
      executor.execute(
        { tenant: operatorA, actor: { type: ActorType.USER, id: operatorA.userId }, scope },
        { name: SEND_MAILBOX_REPLY_TOOL, input, callId: 'c3', approval: approvalFor(input) },
      ),
    );
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') expect(outcome.error.code).toBe('CONNECTION_NOT_FOUND');
    expect(factory.for(foreignConnectionId).sent).toEqual([]);
  });

  it('refuses a connection that is not a mailbox, an unknown one and a disabled one', async () => {
    const { executor, transactions, endpointId, connectionId, manage } = await setup();
    const run = async (id: string) => {
      const input = reply(id);
      return transactions.withTenant(orgA, (scope) =>
        executor.execute(
          { tenant: operatorA, actor: { type: ActorType.USER, id: operatorA.userId }, scope },
          { name: SEND_MAILBOX_REPLY_TOOL, input, callId: `c-${id}`, approval: approvalFor(input) },
        ),
      );
    };
    const notAMailbox = await run(endpointId);
    expect(notAMailbox.status === 'error' && notAMailbox.error.code).toBe('NOT_A_MAILBOX');
    const unknown = await run(newConnectionId());
    expect(unknown.status === 'error' && unknown.error.code).toBe('CONNECTION_NOT_FOUND');

    expect((await manage.setStatus(ownerA, connectionId, 'disabled')).ok).toBe(true);
    const disabled = await run(connectionId);
    expect(disabled.status === 'error' && disabled.error.code).toBe('CONNECTION_DISABLED');
  });

  it('refuses a caller without ai:invoke and validates the input before touching the mailbox', async () => {
    const { executor, transactions, factory, connectionId } = await setup();
    const input = reply(connectionId);
    const byViewer = await transactions.withTenant(orgA, (scope) =>
      executor.execute(
        { tenant: viewerA, actor: { type: ActorType.USER, id: viewerA.userId }, scope },
        { name: SEND_MAILBOX_REPLY_TOOL, input, callId: 'c5', approval: approvalFor(input) },
      ),
    );
    expect(byViewer.status === 'error' && byViewer.error.code).toBe('PERMISSION_DENIED');

    const malformed = { ...input, to: ['not-an-address'] };
    const invalid = await transactions.withTenant(orgA, (scope) =>
      executor.execute(
        { tenant: operatorA, actor: { type: ActorType.USER, id: operatorA.userId }, scope },
        {
          name: SEND_MAILBOX_REPLY_TOOL,
          input: malformed,
          callId: 'c6',
          approval: {
            id: '0192b4c1-0000-7000-8000-000000000002',
            toolName: SEND_MAILBOX_REPLY_TOOL,
            inputHash: digestOf(malformed),
          },
        },
      ),
    );
    expect(invalid.status === 'error' && invalid.error.code).toBe('INVALID_TOOL_INPUT');
    expect(factory.for(connectionId).sent).toEqual([]);
  });

  it('honours a company that raised the level to auto-execute, and one that lowered it to suggest', async () => {
    const { executor, transactions, factory, connectionId, policy } = await setup();
    const input = reply(connectionId);
    policy.setOverrides(orgA, { byTool: { [SEND_MAILBOX_REPLY_TOOL]: PolicyLevel.AUTO_EXECUTE } });
    const auto = await transactions.withTenant(orgA, (scope) =>
      executor.execute(
        { tenant: operatorA, actor: { type: ActorType.AI, id: 'commercial_inbox@1' }, scope },
        { name: SEND_MAILBOX_REPLY_TOOL, input, callId: 'c7' },
      ),
    );
    expect(auto.status).toBe('ok');
    expect(factory.for(connectionId).sent).toHaveLength(1);

    policy.setOverrides(orgA, { byTool: { [SEND_MAILBOX_REPLY_TOOL]: PolicyLevel.SUGGEST } });
    const suggested = await transactions.withTenant(orgA, (scope) =>
      executor.execute(
        { tenant: operatorA, actor: { type: ActorType.USER, id: operatorA.userId }, scope },
        { name: SEND_MAILBOX_REPLY_TOOL, input, callId: 'c8', approval: approvalFor(input) },
      ),
    );
    expect(suggested.status).toBe('not_permitted');
    expect(factory.for(connectionId).sent).toHaveLength(1);
  });
});
