import {
  ActorType,
  AiSystemRegistry,
  AnalyzeDocument,
  AuditTrail,
  CORE_RULES,
  CaseEngine,
  CaseProjection,
  CompositeTextExtractor,
  ConnectionSecrets,
  CredentialCipher,
  DocumentEvidenceVerifier,
  EmailTextExtractor,
  EntityResolver,
  EventLedger,
  FAKE_MAILBOX_PROVIDER,
  FakeMailboxFactory,
  FixedClock,
  HtmlTextExtractor,
  ImportEntities,
  InMemoryActionPolicy,
  InMemoryAuditLogRepository,
  InMemoryCaseRepository,
  InMemoryConnectionRepository,
  InMemoryConnectionStore,
  InMemoryDocumentRepository,
  InMemoryDocumentStore,
  InMemoryDocumentTextRepository,
  InMemoryEntityAliasRepository,
  InMemoryEntityRepository,
  InMemoryEntityStore,
  InMemoryLedgerRepository,
  InMemoryMembershipRepository,
  InMemoryObjectStorage,
  InMemoryOrganizationRepository,
  InMemoryTenancyStore,
  InMemoryTransactionRunner,
  IngestDocument,
  IngestMailboxMessage,
  MailparserMimeParser,
  ManageConnections,
  type OrganizationId,
  PlainTextExtractor,
  RuleRegistry,
  type TenantContext,
  ToolExecutor,
  ToolRegistry,
  WorkspaceConfiguration,
  InMemoryCompanyProfileRepository,
  InMemoryCompanyRuleRepository,
  InMemoryPolicyOverrideRepository,
  InMemoryTerminologyRepository,
  InMemoryWorkspaceStore,
  authorizer,
  createSendMailboxReplyTool,
  newOrganizationId,
  newUserId,
  noExecutionContext,
  noopLogger,
} from '@dolmir/core';

import type { FakeLlmProvider } from '@dolmir/core';

import type { CommercialInboxOptions } from '../system.js';
import { createCommercialInboxSystem } from '../system.js';

export type Harness = Awaited<ReturnType<typeof buildHarness>>;

/**
 * One wiring of the whole chain with in-memory adapters, so a test can feed a
 * real MIME message in and read the resulting case out. Everything it uses is
 * the production code path: the same ingestion, the same case engine, the same
 * evidence verification and the same policy.
 */
export const FIXED_NOW = new Date('2026-09-03T10:00:00.000Z');

export interface HarnessOptions {
  readonly llm: FakeLlmProvider;
  readonly draftReply?: CommercialInboxOptions['draftReply'];
  /** Defaults to the product behaviour: the system drafts a reply. */
  readonly proposeReplies?: boolean;
  readonly rules?: Readonly<Record<string, unknown>>;
  /** The company profile a real tenant configures; absent means the bare default. */
  readonly profile?: Parameters<WorkspaceConfiguration['updateProfile']>[2];
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  return buildHarness(options);
}

async function buildHarness(options: HarnessOptions) {
  const clock = new FixedClock(FIXED_NOW);
  const transactions = new InMemoryTransactionRunner();
  const organizationId = newOrganizationId();
  const operatorId = newUserId();
  const operator: TenantContext = {
    organizationId,
    organizationSlug: 'alfa',
    userId: operatorId,
    roleKey: 'operator',
  };
  const owner: TenantContext = { ...operator, userId: newUserId(), roleKey: 'owner' };

  const tenancy = new InMemoryTenancyStore(clock);
  const organizations = new InMemoryOrganizationRepository(tenancy);
  tenancy.organizations.set(organizationId, {
    id: organizationId,
    slug: 'alfa',
    name: 'Alfa Meccanica S.r.l.',
    status: 'active',
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
  for (const tenant of [operator, owner]) {
    tenancy.memberships.push({
      organizationId,
      userId: tenant.userId,
      roleKey: tenant.roleKey,
      status: 'active',
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
  }
  const memberships = new InMemoryMembershipRepository(tenancy);
  const auditRepository = new InMemoryAuditLogRepository();
  const audit = new AuditTrail({ repository: auditRepository, clock, context: noExecutionContext });

  const documentStore = new InMemoryDocumentStore(clock);
  const documents = new InMemoryDocumentRepository(documentStore);
  const texts = new InMemoryDocumentTextRepository(documentStore);
  const parser = new MailparserMimeParser();
  const ledgerRepository = new InMemoryLedgerRepository(clock);
  const ledger = new EventLedger({ repository: ledgerRepository, context: noExecutionContext });
  const ingest = new IngestMailboxMessage({
    transactions,
    parser,
    ingest: new IngestDocument({
      transactions,
      documents,
      texts,
      storage: new InMemoryObjectStorage(clock),
      extractor: new CompositeTextExtractor([
        new EmailTextExtractor(parser),
        new PlainTextExtractor(),
        new HtmlTextExtractor(),
      ]),
      ledger,
      clock,
    }),
    audit,
    clock,
  });

  const entityStore = new InMemoryEntityStore(clock);
  const entities = new InMemoryEntityRepository(entityStore);
  const aliases = new InMemoryEntityAliasRepository(entityStore);
  const importEntities = new ImportEntities({ transactions, entities, aliases, audit });
  const resolver = new EntityResolver({ entities, aliases });

  const workspaceStore = new InMemoryWorkspaceStore();
  const ruleRegistry = new RuleRegistry();
  for (const rule of CORE_RULES) ruleRegistry.register(rule);
  const system = createCommercialInboxSystem({
    resolveReplyConnection: async () => connectionId,
    ...(options.draftReply === undefined ? {} : { draftReply: options.draftReply }),
    ...(options.proposeReplies === undefined ? {} : { proposeReplies: options.proposeReplies }),
  });
  for (const rule of system.rules) ruleRegistry.register(rule);
  const policyOverrides = new InMemoryPolicyOverrideRepository(workspaceStore);
  const workspace = new WorkspaceConfiguration({
    profiles: new InMemoryCompanyProfileRepository(workspaceStore),
    rules: new InMemoryCompanyRuleRepository(workspaceStore),
    terminology: new InMemoryTerminologyRepository(workspaceStore),
    policyOverrides,
    ruleRegistry,
    audit,
    clock,
  });
  if (options.profile !== undefined) {
    const saved = await transactions.withTenant(organizationId, (scope) =>
      workspace.updateProfile(scope, owner, options.profile as never, 'alfa'),
    );
    if (!saved.ok) throw saved.error;
  }
  for (const [key, value] of Object.entries(options.rules ?? {})) {
    const set = await transactions.withTenant(organizationId, (scope) =>
      workspace.setRule(scope, owner, key, value, 'test'),
    );
    if (!set.ok) throw set.error;
  }

  const connectionStore = new InMemoryConnectionStore(clock);
  const connections = new InMemoryConnectionRepository(connectionStore);
  const cipher = CredentialCipher.fromBase64(CredentialCipher.generateKeyBase64());
  const mailboxes = new FakeMailboxFactory();
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
    credentials: { user: 'vendite@alfa.test', pass: 'app-password' },
  });
  if (!created.ok) throw created.error;
  const connectionId = created.value.id;

  const tools = new ToolRegistry().register(
    createSendMailboxReplyTool({
      connections,
      secrets: new ConnectionSecrets({ connections, cipher }),
      factory: mailboxes,
      clock,
    }),
  );
  const policy = new InMemoryActionPolicy();
  const cases = new InMemoryCaseRepository();
  const projection = new CaseProjection(cases);
  const engine = new CaseEngine({
    transactions,
    ledger,
    cases,
    projection,
    tools,
    policy,
    executor: new ToolExecutor({ registry: tools, authorizer, policy, audit, clock }),
    authorizer,
    memberships,
    clock,
    evidence: new DocumentEvidenceVerifier(texts),
  });
  const analyze = new AnalyzeDocument({
    transactions,
    documents,
    texts,
    organizations,
    workspace,
    systems: new AiSystemRegistry().register(system),
    cases,
    engine,
    llm: options.llm,
    entities: resolver,
    clock,
    logger: noopLogger,
  });

  return {
    clock,
    organizationId,
    operator,
    owner,
    connectionId,
    transactions,
    documents,
    texts,
    cases,
    engine,
    analyze,
    ingest,
    importEntities,
    workspace,
    policy,
    mailboxes,
    auditRepository,
    ledgerRepository,
    llm: options.llm,
    async deliver(raw: string, sourceRef = 'ingest:test-1') {
      const result = await ingest.execute({
        tenantId: organizationId,
        raw: new TextEncoder().encode(raw),
        sourceRef,
        actor: { type: ActorType.SERVICE, id: 'test' },
        recordedBy: 'test',
      });
      if (!result.ok) throw result.error;
      return result.value;
    },
    async seedEntities(rows: Parameters<ImportEntities['execute']>[2]['rows']) {
      const imported = await importEntities.execute(
        organizationId,
        { type: ActorType.USER, id: owner.userId },
        { source: 'test', rows },
      );
      if (!imported.ok) throw imported.error;
      return imported.value;
    },
  };
}

export const organizationOf = (harness: Harness): OrganizationId => harness.organizationId;
