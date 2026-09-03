import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ActorType,
  AiSystemRegistry,
  AiUsageTracker,
  AnalyzeDocument,
  CaseEngine,
  CaseProjection,
  type CaseRepository,
  CompositeTextExtractor,
  ConnectionSecrets,
  type ConnectionRepository,
  CredentialCipher,
  DocumentEvidenceVerifier,
  type DocumentRepository,
  type DocumentTextRepository,
  EmailTextExtractor,
  EntityResolver,
  FakeMailboxFactory,
  HtmlTextExtractor,
  ImapSmtpConnectorFactory,
  ImportEntities,
  InMemoryJobQueue,
  IngestDocument,
  IngestMailboxMessage,
  type JobQueuePort,
  type MailboxConnectorFactory,
  MailparserMimeParser,
  ManageConnections,
  PersistedActionPolicy,
  PgBossJobQueue,
  PlainTextExtractor,
  PollMailbox,
  PostgresCaseRepository,
  PostgresCompanyProfileRepository,
  PostgresCompanyRuleRepository,
  PostgresConnectionRepository,
  PostgresDocumentRepository,
  PostgresDocumentTextRepository,
  PostgresEntityAliasRepository,
  PostgresEntityRepository,
  PostgresIngestionNonceRepository,
  PostgresPolicyOverrideRepository,
  PostgresTerminologyRepository,
  ReceiveSignedMessage,
  RuleRegistry,
  CORE_RULES,
  WorkspaceConfiguration,
  analyzeDocumentJob,
  createSendMailboxReplyTool,
  mailboxPollJob,
  type AiUsageRepository,
  type AuditLogRepository,
  AuditTrail,
  type Authorizer,
  type Clock,
  type Config,
  DEFAULT_COST_BOOK,
  DevTokenIssuer,
  EventLedger,
  type HttpFetch,
  type LedgerRepository,
  ListUserOrganizations,
  type LlmProviderPort,
  type Logger,
  LoggingTelemetry,
  type MembershipRepository,
  type ObjectStoragePort,
  type OrganizationRepository,
  PostgresAiUsageRepository,
  PostgresAuditLogRepository,
  PostgresLedgerRepository,
  PostgresMembershipRepository,
  PostgresOrganizationRepository,
  PostgresTransactionRunner,
  PostgresUserRepository,
  ProvisionOrganization,
  RecordedLlmProvider,
  ResolveTenantContext,
  SYSTEM_ACTOR,
  type Telemetry,
  type TokenVerifier,
  ToolExecutor,
  ToolRegistry,
  type UserRepository,
  authorizer,
  createLlmProvider,
  createObjectStorage,
  createPinoLogger,
  createPostgresPool,
  createRequestHumanDecisionTool,
  declareNonDeterminatoTool,
  diagnoseDatabase,
  executionContextProvider,
  isDomainError,
  jwtVerifierFromConfig,
  readMigrationStatus,
  systemClock,
} from '@dolmir/core';
import { createCommercialInboxSystem } from '@dolmir/system-commercial-inbox';

/**
 * The composition root (ADR-0003): the one place that knows concrete
 * adapters and wires them into use cases with explicit constructor
 * injection. Nothing here contains behaviour; everything here is replaceable
 * in tests by passing a different `Config` or options.
 */
export interface ContainerOptions {
  readonly logger?: Logger;
  readonly clock?: Clock;
  /** Injected into the AI provider adapter (contract tests replay recorded exchanges). */
  readonly fetch?: HttpFetch;
  readonly migrationsDirectory?: string;
  /**
   * The AI Systems this deployment ships. The composition root of a real
   * deployment passes them; tests pass the ones they exercise.
   */
  readonly systems?: readonly Parameters<AiSystemRegistry['register']>[0][];
  /** Replaces the mailbox factory; the end-to-end tests pass a fake here. */
  readonly mailboxes?: MailboxConnectorFactory;
  /**
   * Replaces the model provider. Tests script it so the chain is exercised
   * deterministically; a deployment always uses the configured provider.
   */
  readonly llm?: LlmProviderPort;
}

export interface ReadinessReport {
  readonly status: 'ready' | 'not_ready';
  readonly checks: {
    readonly database:
      | {
          readonly status: 'ok' | 'misconfigured';
          readonly latencyMs: number;
          readonly serverVersion: string;
          readonly role: string;
          readonly bypassesRls: boolean;
        }
      | { readonly status: 'unreachable'; readonly code: string };
    readonly migrations:
      | {
          readonly status: 'ok' | 'pending' | 'mismatch' | 'not_migrated';
          readonly applied: number;
          readonly pending: readonly string[];
          readonly mismatches: readonly string[];
        }
      | { readonly status: 'unknown'; readonly code: string };
    readonly ai: { readonly status: 'ok' | 'not_configured'; readonly provider: string };
  };
}

export interface Container {
  readonly config: Config;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly telemetry: Telemetry;
  readonly pool: ReturnType<typeof createPostgresPool>;
  readonly transactions: PostgresTransactionRunner;
  readonly repositories: {
    readonly organizations: OrganizationRepository;
    readonly users: UserRepository;
    readonly memberships: MembershipRepository;
    readonly audit: AuditLogRepository;
    readonly ledger: LedgerRepository;
    readonly aiUsage: AiUsageRepository;
  };
  readonly audit: AuditTrail;
  readonly ledger: EventLedger;
  readonly tenancy: {
    readonly provision: ProvisionOrganization;
    readonly resolveTenant: ResolveTenantContext;
    readonly listUserOrganizations: ListUserOrganizations;
  };
  readonly identity: {
    readonly verifier: TokenVerifier;
    /** Only outside production, only with an HS256 secret. */
    readonly devTokenIssuer: DevTokenIssuer | undefined;
  };
  readonly authorizer: Authorizer;
  readonly ai: {
    readonly provider: LlmProviderPort;
    readonly usage: AiUsageTracker;
    readonly tools: ToolRegistry;
    readonly executor: ToolExecutor;
  };
  readonly documents: {
    readonly repository: DocumentRepository;
    readonly texts: DocumentTextRepository;
    readonly ingest: IngestDocument;
  };
  readonly entities: {
    readonly resolver: EntityResolver;
    readonly import: ImportEntities;
  };
  readonly workspace: {
    readonly configuration: WorkspaceConfiguration;
    readonly rules: RuleRegistry;
  };
  readonly connectors: {
    readonly connections: ConnectionRepository;
    readonly secrets: ConnectionSecrets;
    readonly manage: ManageConnections;
    readonly ingestMessage: IngestMailboxMessage;
    readonly receiveSigned: ReceiveSignedMessage;
    readonly poll: PollMailbox;
    readonly mailboxes: MailboxConnectorFactory;
  };
  readonly cases: {
    readonly repository: CaseRepository;
    readonly engine: CaseEngine;
    readonly analyze: AnalyzeDocument;
    readonly systems: AiSystemRegistry;
  };
  readonly jobs: {
    readonly queue: JobQueuePort;
    /** Registers the handlers and, for pg-boss, starts polling. */
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  readonly storage: ObjectStoragePort;
  readonly migrationsDirectory: string;
  readiness(): Promise<ReadinessReport>;
  close(): Promise<void>;
}

const DEFAULT_MIGRATIONS_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations',
);

export function createContainer(config: Config, options: ContainerOptions = {}): Container {
  const clock = options.clock ?? systemClock;
  const logger =
    options.logger ??
    createPinoLogger({
      level: config.log.level,
      format: config.log.format,
      base: { service: 'dolmir-api', env: config.env },
    });
  const telemetry = new LoggingTelemetry(logger);

  const pool = createPostgresPool({
    connectionString: config.database.url.reveal(),
    max: config.database.poolMax,
    applicationName: 'dolmir-api',
    logger,
  });

  const repositories = {
    organizations: new PostgresOrganizationRepository(),
    users: new PostgresUserRepository(),
    memberships: new PostgresMembershipRepository(),
    audit: new PostgresAuditLogRepository(),
    ledger: new PostgresLedgerRepository(),
    aiUsage: new PostgresAiUsageRepository(),
  };

  const audit = new AuditTrail({
    repository: repositories.audit,
    clock,
    context: executionContextProvider,
  });

  // Every system-scope transaction leaves an audit entry in the same transaction (ADR-0005).
  const transactions = new PostgresTransactionRunner(pool, logger, {
    onSystemScopeOpened: async (scope) => {
      await audit.record(scope, {
        organizationId: null,
        actor: SYSTEM_ACTOR,
        action: 'system_scope.opened',
        details: { reason: scope.reason },
      });
    },
  });

  const ledger = new EventLedger({
    repository: repositories.ledger,
    context: executionContextProvider,
  });

  const tenancyDeps = {
    transactions,
    organizations: repositories.organizations,
    users: repositories.users,
    memberships: repositories.memberships,
  };
  const tenancy = {
    provision: new ProvisionOrganization({ ...tenancyDeps, audit }),
    resolveTenant: new ResolveTenantContext(tenancyDeps),
    listUserOrganizations: new ListUserOrganizations(tenancyDeps),
  };

  const identity = {
    verifier: jwtVerifierFromConfig(config.auth, clock),
    devTokenIssuer:
      config.auth.hs256Secret !== undefined && config.env !== 'production'
        ? new DevTokenIssuer({
            issuer: config.auth.issuer,
            audience: config.auth.audience,
            secret: new TextEncoder().encode(config.auth.hs256Secret.reveal()),
            clock,
          })
        : undefined,
  };

  const aiUsage = new AiUsageTracker({
    repository: repositories.aiUsage,
    transactions,
    clock,
    context: executionContextProvider,
  });
  const rawProvider =
    options.llm ??
    createLlmProvider(config.ai, {
      clock,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const provider = new RecordedLlmProvider({
    inner: rawProvider,
    usage: aiUsage,
    costBook: DEFAULT_COST_BOOK,
    clock,
    telemetry,
    logger,
  });
  const tools = new ToolRegistry()
    .register(declareNonDeterminatoTool)
    .register(createRequestHumanDecisionTool(clock));
  // Declared before the policy it uses, so the tools registered below share it.
  const policyForTools = new PersistedActionPolicy({
    transactions,
    overrides: new PostgresPolicyOverrideRepository(),
  });
  const executor = new ToolExecutor({
    registry: tools,
    authorizer,
    policy: policyForTools,
    audit,
    clock,
    logger,
  });

  const storage = createObjectStorage(config.storage, clock);
  const migrationsDirectory = options.migrationsDirectory ?? DEFAULT_MIGRATIONS_DIRECTORY;

  // ---- Phase 2: documents, entities, company memory, connectors, cases, jobs ----
  const documentRepository = new PostgresDocumentRepository();
  const documentTexts = new PostgresDocumentTextRepository();
  const mimeParser = new MailparserMimeParser();
  const documentIngest = new IngestDocument({
    transactions,
    documents: documentRepository,
    texts: documentTexts,
    storage,
    extractor: new CompositeTextExtractor([
      new EmailTextExtractor(mimeParser),
      new PlainTextExtractor(),
      new HtmlTextExtractor(),
    ]),
    ledger,
    clock,
    logger,
  });

  const entityRepository = new PostgresEntityRepository();
  const entityAliases = new PostgresEntityAliasRepository();
  const entityResolver = new EntityResolver({
    entities: entityRepository,
    aliases: entityAliases,
  });
  const importEntities = new ImportEntities({
    transactions,
    entities: entityRepository,
    aliases: entityAliases,
    audit,
  });

  const connectionRepository = new PostgresConnectionRepository();

  const ruleRegistry = new RuleRegistry();
  for (const rule of CORE_RULES) ruleRegistry.register(rule);
  const systems = new AiSystemRegistry();
  // The AI Systems this deployment ships. A test may replace them; a running
  // deployment always has them, so their rules are registered and their cases
  // can be opened.
  const shippedSystems =
    options.systems ??
    ([
      createCommercialInboxSystem({
        resolveReplyConnection: async (input) => {
          const mailboxes = await transactions.withTenant(input.tenantId, (scope) =>
            connectionRepository.list(scope, {
              capability: 'mailbox',
              status: 'active',
              limit: 1,
            }),
          );
          return mailboxes[0]?.id ?? null;
        },
      }),
    ] as const);
  for (const system of shippedSystems) {
    systems.register(system);
    for (const rule of system.rules) ruleRegistry.register(rule);
  }
  const policyOverrides = new PostgresPolicyOverrideRepository();
  const workspaceConfiguration = new WorkspaceConfiguration({
    profiles: new PostgresCompanyProfileRepository(),
    rules: new PostgresCompanyRuleRepository(),
    terminology: new PostgresTerminologyRepository(),
    policyOverrides,
    ruleRegistry,
    audit,
    clock,
  });
  const actionPolicy = new PersistedActionPolicy({ transactions, overrides: policyOverrides });

  // Without a secrets key no connection can be created; the loader already
  // refuses to boot production without one, so this only affects development.
  const cipher = CredentialCipher.fromBase64(
    config.secrets.key?.reveal() ?? CredentialCipher.generateKeyBase64(),
  );
  const connectionSecrets = new ConnectionSecrets({
    connections: connectionRepository,
    cipher,
  });
  const mailboxes =
    options.mailboxes ??
    (config.mailbox.driver === 'fake' ? new FakeMailboxFactory() : new ImapSmtpConnectorFactory());

  const jobQueue: JobQueuePort =
    config.jobs.driver === 'pg-boss'
      ? new PgBossJobQueue({
          connectionString: config.database.url.reveal(),
          schema: config.jobs.schema,
          logger,
        })
      : new InMemoryJobQueue(clock);

  const ingestMessage = new IngestMailboxMessage({
    transactions,
    parser: mimeParser,
    ingest: documentIngest,
    audit,
    clock,
    logger,
    scheduler: {
      scheduleAnalysis: async (tenantId, documentId) => {
        await jobQueue.enqueue(
          analyzeDocumentJob,
          { tenantId, documentId },
          { idempotencyKey: `analyze:${documentId}` },
        );
      },
    },
  });

  tools.register(
    createSendMailboxReplyTool({
      connections: connectionRepository,
      secrets: connectionSecrets,
      factory: mailboxes,
      clock,
    }),
  );

  const caseRepository = new PostgresCaseRepository();
  const caseProjection = new CaseProjection(caseRepository);
  const caseEngine = new CaseEngine({
    transactions,
    ledger,
    cases: caseRepository,
    projection: caseProjection,
    tools,
    policy: actionPolicy,
    executor,
    authorizer,
    memberships: repositories.memberships,
    clock,
    logger,
    evidence: new DocumentEvidenceVerifier(documentTexts),
  });
  const analyzeDocument = new AnalyzeDocument({
    transactions,
    documents: documentRepository,
    texts: documentTexts,
    organizations: repositories.organizations,
    workspace: workspaceConfiguration,
    systems,
    cases: caseRepository,
    engine: caseEngine,
    llm: provider,
    entities: entityResolver,
    clock,
    logger,
  });

  const pollMailbox = new PollMailbox({
    transactions,
    connections: connectionRepository,
    secrets: connectionSecrets,
    factory: mailboxes,
    ingest: ingestMessage,
    audit,
    clock,
    logger,
  });

  let jobsStarted = false;
  const startJobs = async (): Promise<void> => {
    if (jobsStarted) return;
    jobsStarted = true;
    if (jobQueue instanceof PgBossJobQueue) await jobQueue.start();
    await jobQueue.work(analyzeDocumentJob, async (payload) => {
      const report = await analyzeDocument.execute(payload.tenantId, payload.documentId);
      if (!report.ok) throw report.error;
    });
    await jobQueue.work(mailboxPollJob, async (payload) => {
      const report = await pollMailbox.execute(payload.tenantId, payload.connectionId);
      if (!report.ok) throw report.error;
    });
  };
  const stopJobs = async (): Promise<void> => {
    if (jobQueue instanceof PgBossJobQueue) await jobQueue.stop();
    jobsStarted = false;
  };

  return {
    config,
    logger,
    clock,
    telemetry,
    pool,
    transactions,
    repositories,
    audit,
    ledger,
    tenancy,
    identity,
    authorizer,
    ai: { provider, usage: aiUsage, tools, executor },
    documents: { repository: documentRepository, texts: documentTexts, ingest: documentIngest },
    entities: { resolver: entityResolver, import: importEntities },
    workspace: { configuration: workspaceConfiguration, rules: ruleRegistry },
    connectors: {
      connections: connectionRepository,
      secrets: connectionSecrets,
      manage: new ManageConnections({
        transactions,
        connections: connectionRepository,
        cipher,
        authorizer,
        audit,
        clock,
        logger,
      }),
      ingestMessage,
      receiveSigned: new ReceiveSignedMessage({
        transactions,
        connections: connectionRepository,
        secrets: connectionSecrets,
        nonces: new PostgresIngestionNonceRepository(),
        ingest: ingestMessage,
        audit,
        clock,
        logger,
      }),
      poll: pollMailbox,
      mailboxes,
    },
    cases: {
      repository: caseRepository,
      engine: caseEngine,
      analyze: analyzeDocument,
      systems,
    },
    jobs: { queue: jobQueue, start: startJobs, stop: stopJobs },
    storage,
    migrationsDirectory,
    readiness: () => readiness(pool, migrationsDirectory, rawProvider.name),
    close: async () => {
      await stopJobs();
      await pool.end();
    },
  };
}

async function readiness(
  pool: ReturnType<typeof createPostgresPool>,
  migrationsDirectory: string,
  providerName: string,
): Promise<ReadinessReport> {
  const database = await diagnoseDatabase(pool);
  const databaseCheck: ReadinessReport['checks']['database'] = database.ok
    ? {
        status: database.value.bypassesRls || database.value.superuser ? 'misconfigured' : 'ok',
        latencyMs: database.value.latencyMs,
        serverVersion: database.value.serverVersion,
        role: database.value.currentUser,
        bypassesRls: database.value.bypassesRls || database.value.superuser,
      }
    : { status: 'unreachable', code: database.error.code };

  let migrationsCheck: ReadinessReport['checks']['migrations'];
  if (database.ok) {
    try {
      const status = await readMigrationStatus(pool, migrationsDirectory);
      migrationsCheck = {
        status:
          status.checksumMismatches.length > 0
            ? 'mismatch'
            : status.pending.length > 0
              ? 'pending'
              : 'ok',
        applied: status.applied.length,
        pending: status.pending.map((file) => file.version),
        mismatches: status.checksumMismatches.map((m) => m.version),
      };
    } catch (error) {
      // 42P01 (undefined table): the migration ledger itself does not exist yet.
      const sqlState = isDomainError(error) ? error.details['sqlState'] : undefined;
      migrationsCheck =
        sqlState === '42P01'
          ? { status: 'not_migrated', applied: 0, pending: [], mismatches: [] }
          : { status: 'unknown', code: isDomainError(error) ? error.code : 'UNKNOWN' };
    }
  } else {
    migrationsCheck = { status: 'unknown', code: 'DATABASE_UNREACHABLE' };
  }

  const ai: ReadinessReport['checks']['ai'] = {
    status: providerName === 'none' ? 'not_configured' : 'ok',
    provider: providerName,
  };

  const ready = databaseCheck.status === 'ok' && migrationsCheck.status === 'ok';
  return {
    status: ready ? 'ready' : 'not_ready',
    checks: { database: databaseCheck, migrations: migrationsCheck, ai },
  };
}

/** The actor recorded for actions the platform performs on its own behalf. */
export const PLATFORM_ACTOR = { type: ActorType.SYSTEM, id: 'dolmir-api' } as const;
