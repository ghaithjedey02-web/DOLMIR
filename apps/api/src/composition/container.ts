import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ActorType,
  AiUsageTracker,
  type AiUsageRepository,
  type AuditLogRepository,
  AuditTrail,
  type Authorizer,
  type Clock,
  type Config,
  DEFAULT_COST_BOOK,
  DefaultActionPolicy,
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
  const rawProvider = createLlmProvider(config.ai, {
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
  const executor = new ToolExecutor({
    registry: tools,
    authorizer,
    policy: new DefaultActionPolicy(),
    audit,
    clock,
    logger,
  });

  const storage = createObjectStorage(config.storage, clock);
  const migrationsDirectory = options.migrationsDirectory ?? DEFAULT_MIGRATIONS_DIRECTORY;

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
    storage,
    migrationsDirectory,
    readiness: () => readiness(pool, migrationsDirectory, rawProvider.name),
    close: async () => {
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
