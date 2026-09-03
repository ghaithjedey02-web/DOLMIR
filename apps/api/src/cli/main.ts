import { parseArgs } from 'node:util';

import { Migrator, loadConfig, noopLogger } from '@dolmir/core';

import { type Container, createContainer } from '../composition/container.js';
import { readEnvironment } from '../composition/env.js';

/**
 * Operator commands. Every command validates configuration first and prints
 * problems instead of stack traces. Secrets are never printed.
 *
 *   dolmir migrate                          apply pending migrations (owner connection)
 *   dolmir doctor                           configuration, database, role, migrations, AI provider
 *   dolmir dev-token --subject <sub> [--email <e>] [--name <n>] [--ttl-seconds <s>]
 *   dolmir provision-org --slug <s> --name <n> --owner-subject <sub> [--owner-email <e>] [--owner-name <n>]
 */
const USAGE = `usage:
  dolmir migrate
  dolmir doctor
  dolmir dev-token --subject <sub> [--email <e>] [--name <n>] [--ttl-seconds <s>]
  dolmir provision-org --slug <s> --name <n> --owner-subject <sub> [--owner-email <e>] [--owner-name <n>]
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

async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'migrate':
      await migrate();
      return;
    case 'doctor':
      await doctor();
      return;
    case 'dev-token':
      await devToken(rest);
      return;
    case 'provision-org':
      await provisionOrg(rest);
      return;
    case undefined:
    default:
      fail(USAGE, 2);
  }
}

run(process.argv.slice(2)).catch((error: unknown) => {
  fail(`error: ${error instanceof Error ? error.message : String(error)}`);
});
