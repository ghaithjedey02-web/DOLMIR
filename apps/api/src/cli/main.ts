import { parseArgs } from 'node:util';

import {
  Migrator,
  installJobQueue,
  loadConfig,
  noopLogger,
  runtimeRoleFromConnectionString,
} from '@dolmir/core';

import { type Container, createContainer } from '../composition/container.js';
import { readEnvironment } from '../composition/env.js';
import { PLATFORM_JOBS } from '../composition/jobs.js';
import { demoCase, demoCases, demoDecide, demoSeed, demoSend } from './demo.js';
import { type PreflightReport, runPreflight } from './preflight.js';
import { type SafetyReport, runSafety } from './safety.js';

/**
 * Operator commands. Every command validates configuration first and prints
 * problems instead of stack traces. Secrets are never printed.
 *
 *   dolmir migrate                          apply pending migrations (owner connection)
 *   dolmir jobs:install                     create the job queue schema and queues (owner connection)
 *   dolmir doctor                           configuration, database, role, migrations, AI provider
 *   dolmir preflight                        would this deployment start and work? (exit 1 if not)
 *   dolmir safety                           could the AI act outside DOLMIR without a human? (exit 1 if so)
 *   dolmir dev-token --subject <sub> [--email <e>] [--name <n>] [--ttl-seconds <s>]
 *   dolmir provision-org --slug <s> --name <n> --owner-subject <sub> [--owner-email <e>] [--owner-name <n>]
 */
const USAGE = `usage:
  dolmir migrate
  dolmir jobs:install [--role <name>]
  dolmir doctor
  dolmir preflight
  dolmir safety
  dolmir dev-token --subject <sub> [--email <e>] [--name <n>] [--ttl-seconds <s>]
  dolmir provision-org --slug <s> --name <n> --owner-subject <sub> [--owner-email <e>] [--owner-name <n>]

  dolmir demo:seed [--slug <s>] [--owner-subject <sub>]
  dolmir demo:send --org <id> --file <path.eml>
  dolmir demo:cases --org <id>
  dolmir demo:case --org <id> --case <id>
  dolmir demo:approve --org <id> --recommendation <id> --user <id> [--note <text>]
  dolmir demo:reject  --org <id> --recommendation <id> --user <id> [--note <text>]
`;

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const fail = (line: string, code = 1): void => {
  process.stderr.write(`${line}\n`);
  process.exitCode = code;
};

async function withContainer(fn: (container: Container) => Promise<void>): Promise<void> {
  const config = loadConfig(readEnvironment());
  if (!config.ok) {
    fail(config.error.message);
    return;
  }
  const container = createContainer(config.value, { logger: noopLogger });
  try {
    await fn(container);
  } finally {
    await container.close();
  }
}

async function migrate(): Promise<void> {
  await withContainer(async (container) => {
    const ownerUrl = container.config.database.ownerUrl;
    if (ownerUrl === undefined) {
      fail('DOLMIR_DATABASE_OWNER_URL is required to run migrations.', 2);
      return;
    }
    const migrator = new Migrator({
      ownerConnectionString: ownerUrl.reveal(),
      directory: container.migrationsDirectory,
      logger: noopLogger,
    });
    const applied = await migrator.migrate();
    out(
      applied.length === 0
        ? 'migrations: nothing to apply'
        : `migrations applied: ${applied.join(', ')}`,
    );
  });
}

/**
 * Creates the pg-boss schema and one queue per job in `PLATFORM_JOBS`, then
 * grants the runtime role what it needs inside that schema. Deploy-time work,
 * with the owner connection, exactly like `migrate`: the runtime never creates
 * a queue, so without this the production queue has nothing to work and
 * approved actions are enqueued into a schema that does not exist.
 *
 * Idempotent — an existing queue is updated to the definition's current retry
 * and expiry settings rather than recreated — so it belongs on every deploy,
 * next to the migration step.
 */
async function jobsInstall(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { role: { type: 'string' } } });
  await withContainer(async (container) => {
    const { config } = container;
    if (config.jobs.driver !== 'pg-boss') {
      fail(
        `DOLMIR_JOBS_DRIVER is "${config.jobs.driver}"; nothing would use the schema this installs.`,
        2,
      );
      return;
    }
    const ownerUrl = config.database.ownerUrl;
    if (ownerUrl === undefined) {
      fail('DOLMIR_DATABASE_OWNER_URL is required to install the job queue.', 2);
      return;
    }
    // Whoever the runtime connects as is who gets the grants. Naming it twice
    // is how the two drift apart; --role is for the deployments where they
    // genuinely differ.
    const runtimeRole =
      values.role ?? runtimeRoleFromConnectionString(config.database.url.reveal());
    const report = await installJobQueue({
      ownerConnectionString: ownerUrl.reveal(),
      schema: config.jobs.schema,
      runtimeRole,
      jobs: PLATFORM_JOBS,
      logger: noopLogger,
    });
    out(
      `job queue: schema=${report.schema} version=${String(report.schemaVersion)} role=${runtimeRole}`,
    );
    out(
      `queues created: ${report.queuesCreated.length === 0 ? 'none' : report.queuesCreated.join(', ')}`,
    );
    out(
      `queues updated: ${report.queuesUpdated.length === 0 ? 'none' : report.queuesUpdated.join(', ')}`,
    );
  });
}

async function doctor(): Promise<void> {
  await withContainer(async (container) => {
    const { config } = container;
    out(`configuration: valid (env=${config.env}, log=${config.log.level}/${config.log.format})`);
    out(
      `auth: issuer=${config.auth.issuer} audience=${config.auth.audience} key=${config.auth.jwksUrl === undefined ? 'hs256 secret' : 'jwks'}`,
    );
    out(`storage: ${config.storage.driver}`);
    const report = await container.readiness();
    const db = report.checks.database;
    if (db.status === 'unreachable') {
      out(`database: UNREACHABLE (${db.code})`);
    } else {
      out(
        `database: ${db.status} (postgres ${db.serverVersion}, role=${db.role}, bypasses RLS=${db.bypassesRls}, ${db.latencyMs} ms)`,
      );
    }
    const migrations = report.checks.migrations;
    if (migrations.status === 'unknown') {
      out(`migrations: unknown (${migrations.code})`);
    } else {
      out(
        `migrations: ${migrations.status} (applied=${migrations.applied}, pending=${migrations.pending.length}${migrations.mismatches.length > 0 ? `, mismatches=${migrations.mismatches.join(',')}` : ''})`,
      );
    }
    out(`ai: ${report.checks.ai.status} (provider=${report.checks.ai.provider})`);
    out(`readiness: ${report.status}`);
    if (report.status !== 'ready') process.exitCode = 1;
  });
}

/** Every check on one line, problems to stderr, exit 1 when any check failed. */
async function preflight(): Promise<void> {
  await withContainer(async (container) => {
    const report = await runPreflight(container);
    renderPreflight(report);
  });
}

function renderPreflight(report: PreflightReport): void {
  const width = Math.max(...report.checks.map((check) => check.name.length));
  for (const check of report.checks) {
    out(`[${check.status.toUpperCase().padEnd(4)}] ${check.name.padEnd(width)}  ${check.detail}`);
  }
  const failed = report.checks.filter((check) => check.status === 'fail').length;
  const warned = report.checks.filter((check) => check.status === 'warn').length;
  if (report.ok) {
    out(
      `preflight: OK${warned === 0 ? '' : ` (${String(warned)} warning${warned === 1 ? '' : 's'})`}`,
    );
  } else {
    fail(
      `preflight: FAILED — ${String(failed)} check${failed === 1 ? '' : 's'} failed; do not start`,
      1,
    );
  }
}

/** Read-only. Exit 1 when anything could let the AI act externally without a human. */
async function safety(): Promise<void> {
  await withContainer(async (container) => {
    const report = await runSafety(container);
    renderSafety(report);
  });
}

function renderSafety(report: SafetyReport): void {
  for (const section of report.sections) {
    out(section.title);
    for (const line of section.lines) out(`  ${line}`);
    out('');
  }
  if (report.ok) {
    out('posture: SAFE — no action can complete without a human approving it');
  } else {
    for (const reason of report.unsafe) out(`UNSAFE: ${reason}`);
    fail(
      `posture: UNSAFE — ${String(report.unsafe.length)} condition${report.unsafe.length === 1 ? '' : 's'} would let the AI act without a human`,
      1,
    );
  }
}

async function devToken(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      subject: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      'ttl-seconds': { type: 'string' },
    },
  });
  if (values.subject === undefined) {
    fail(USAGE, 2);
    return;
  }
  const ttl = values['ttl-seconds'] === undefined ? undefined : Number(values['ttl-seconds']);
  if (ttl !== undefined && (!Number.isInteger(ttl) || ttl <= 0)) {
    fail('--ttl-seconds must be a positive integer', 2);
    return;
  }
  const subject = values.subject;
  await withContainer(async (container) => {
    const issuer = container.identity.devTokenIssuer;
    if (issuer === undefined) {
      fail('dev tokens need DOLMIR_AUTH_HS256_SECRET and DOLMIR_ENV != production.', 2);
      return;
    }
    const token = await issuer.issue({
      subject,
      ...(values.email === undefined ? {} : { email: values.email }),
      ...(values.name === undefined ? {} : { displayName: values.name }),
      ...(ttl === undefined ? {} : { ttlSeconds: ttl }),
    });
    out(token);
  });
}

async function provisionOrg(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      slug: { type: 'string' },
      name: { type: 'string' },
      'owner-subject': { type: 'string' },
      'owner-email': { type: 'string' },
      'owner-name': { type: 'string' },
    },
  });
  const slug = values.slug;
  const name = values.name;
  const ownerSubject = values['owner-subject'];
  if (slug === undefined || name === undefined || ownerSubject === undefined) {
    fail(USAGE, 2);
    return;
  }
  await withContainer(async (container) => {
    const result = await container.tenancy.provision.execute({
      organization: { slug, name },
      owner: {
        authSubject: ownerSubject,
        ...(values['owner-email'] === undefined ? {} : { email: values['owner-email'] }),
        ...(values['owner-name'] === undefined ? {} : { displayName: values['owner-name'] }),
      },
    });
    if (!result.ok) {
      fail(`${result.error.code}: ${result.error.message}`);
      return;
    }
    out(
      JSON.stringify(
        {
          organizationId: result.value.organization.id,
          slug: result.value.organization.slug,
          ownerUserId: result.value.owner.id,
          roleKey: result.value.membership.roleKey,
        },
        null,
        2,
      ),
    );
  });
}

async function demo(command: string, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      org: { type: 'string' },
      file: { type: 'string' },
      case: { type: 'string' },
      recommendation: { type: 'string' },
      user: { type: 'string' },
      note: { type: 'string' },
      slug: { type: 'string' },
      'owner-subject': { type: 'string' },
    },
  });
  const need = (name: string, value: string | undefined): string => {
    if (value === undefined) {
      fail(USAGE, 2);
      throw new Error(`--${name} is required`);
    }
    return value;
  };
  await withContainer(async (container) => {
    switch (command) {
      case 'demo:seed':
        await demoSeed(
          container,
          {
            slug: values.slug ?? 'alfa',
            ownerSubject: values['owner-subject'] ?? 'auth|demo-owner',
          },
          out,
        );
        return;
      case 'demo:send':
        await demoSend(
          container,
          { organizationId: need('org', values.org), file: need('file', values.file) },
          out,
        );
        return;
      case 'demo:cases':
        await demoCases(container, { organizationId: need('org', values.org) }, out);
        return;
      case 'demo:case':
        await demoCase(
          container,
          { organizationId: need('org', values.org), caseId: need('case', values.case) },
          out,
        );
        return;
      case 'demo:approve':
      case 'demo:reject':
        await demoDecide(
          container,
          {
            organizationId: need('org', values.org),
            recommendationId: need('recommendation', values.recommendation),
            userId: need('user', values.user),
            decision: command === 'demo:approve' ? 'approved' : 'rejected',
            note: values.note ?? null,
          },
          out,
        );
        return;
      default:
        fail(USAGE, 2);
    }
  });
}

async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'migrate':
      await migrate();
      return;
    case 'jobs:install':
      await jobsInstall(rest);
      return;
    case 'doctor':
      await doctor();
      return;
    case 'preflight':
      await preflight();
      return;
    case 'safety':
      await safety();
      return;
    case 'dev-token':
      await devToken(rest);
      return;
    case 'provision-org':
      await provisionOrg(rest);
      return;
    case 'demo:seed':
    case 'demo:send':
    case 'demo:cases':
    case 'demo:case':
    case 'demo:approve':
    case 'demo:reject':
      await demo(command, rest);
      return;
    case undefined:
    default:
      fail(USAGE, 2);
  }
}

run(process.argv.slice(2)).catch((error: unknown) => {
  fail(`error: ${error instanceof Error ? error.message : String(error)}`);
});
