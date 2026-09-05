import { randomBytes } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type AnthropicProbeOptions,
  type AnthropicProbeResult,
  createModelRouting,
  inspectJobQueue,
  probeAnthropic,
} from '@dolmir/core';

import type { Container } from '../composition/container.js';
import { PLATFORM_JOBS } from '../composition/jobs.js';

/**
 * `dolmir preflight` — would this configuration, on this host, against this
 * database, start and do useful work?
 *
 * Every check answers a question a first deployment otherwise answers by
 * failing at run time, one failure at a time: can the runtime role reach the
 * database and is it the restricted one; are the migrations applied; do the
 * queues the workers will poll exist, on the policies their jobs require; can
 * documents be written where configuration says they go; is the model
 * provider reachable with the key it was given. None of it changes anything —
 * the one file written is a probe that is removed before the check reports.
 *
 * Nothing secret is described beyond its presence and length. `fail` means
 * the deployment should not start; `warn` means it would start and an operator
 * should know why that might not be what they wanted.
 */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface PreflightCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface PreflightReport {
  readonly checks: readonly PreflightCheck[];
  /** No check failed. Warnings do not fail a preflight. */
  readonly ok: boolean;
}

export interface PreflightOptions {
  /** Replaces the network probe. Tests pass one so nothing leaves the machine. */
  readonly probe?: (options: AnthropicProbeOptions) => Promise<AnthropicProbeResult>;
}

export async function runPreflight(
  container: Container,
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const { config } = container;
  const production = config.env === 'production';
  const checks: PreflightCheck[] = [];
  const check = (name: string, status: CheckStatus, detail: string): void => {
    checks.push({ name, status, detail });
  };

  // ---- configuration ------------------------------------------------------
  check(
    'configuration',
    production ? 'pass' : 'warn',
    production
      ? 'env=production; the loader has already refused anything production forbids'
      : `env=${config.env}; preflight describes a deployment, and this configuration is for ${config.env}`,
  );

  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.http.host);
  check(
    'http',
    production && loopback ? 'warn' : 'pass',
    production && loopback
      ? `bound to ${config.http.host}:${String(config.http.port)} — inside a container nothing outside it can connect; set DOLMIR_HTTP_HOST=0.0.0.0`
      : `${config.http.host}:${String(config.http.port)}`,
  );

  // ---- database and migrations -------------------------------------------
  const readiness = await container.readiness();
  const database = readiness.checks.database;
  let databaseReachable = false;
  if (database.status === 'unreachable') {
    check('database', 'fail', `unreachable (${database.code})`);
  } else {
    databaseReachable = true;
    const role = `role=${database.role}`;
    if (database.status === 'misconfigured') {
      check(
        'database',
        'fail',
        `${role} can bypass row-level security (superuser or BYPASSRLS); the runtime must connect as the restricted role`,
      );
    } else {
      check(
        'database',
        'pass',
        `postgres ${database.serverVersion}, ${role}, NOBYPASSRLS, ${String(database.latencyMs)} ms`,
      );
    }
  }

  const migrations = readiness.checks.migrations;
  switch (migrations.status) {
    case 'ok':
      check('migrations', 'pass', `${String(migrations.applied)} applied, none pending`);
      break;
    case 'pending':
      check(
        'migrations',
        'fail',
        `${String(migrations.pending.length)} pending (${migrations.pending.join(', ')}); run \`dolmir migrate\``,
      );
      break;
    case 'mismatch':
      check(
        'migrations',
        'fail',
        `applied migrations differ from the files shipped: ${migrations.mismatches.join(', ')}`,
      );
      break;
    case 'not_migrated':
      check('migrations', 'fail', 'the database has never been migrated; run `dolmir migrate`');
      break;
    case 'unknown':
      check('migrations', databaseReachable ? 'fail' : 'skip', `unknown (${migrations.code})`);
      break;
  }

  // ---- background queue ---------------------------------------------------
  if (config.jobs.driver === 'pg-boss') {
    check('jobs.driver', 'pass', `pg-boss, schema ${config.jobs.schema}`);
    if (!databaseReachable) {
      check('jobs.queues', 'skip', 'database unreachable');
    } else {
      const inspection = await inspectJobQueue(container.pool, {
        schema: config.jobs.schema,
        jobs: PLATFORM_JOBS,
      });
      if (!inspection.schemaPresent) {
        check(
          'jobs.queues',
          'fail',
          `schema ${config.jobs.schema} does not exist; run \`dolmir jobs:install\` with the owner connection`,
        );
      } else {
        const wrong = inspection.queues.filter((queue) => !queue.ok);
        if (wrong.length > 0) {
          check(
            'jobs.queues',
            'fail',
            wrong
              .map((queue) =>
                queue.present
                  ? `${queue.name} is on policy "${String(queue.policy)}" but needs "${queue.expectedPolicy}"`
                  : `${queue.name} has no queue`,
              )
              .join('; ') + '; run `dolmir jobs:install`',
          );
        } else {
          check(
            'jobs.queues',
            'pass',
            inspection.queues.map((queue) => `${queue.name} (${queue.expectedPolicy})`).join(', '),
          );
        }
      }
    }
  } else {
    // The loader refuses this in production; outside it, say what it costs.
    check(
      'jobs.driver',
      'warn',
      'in-memory queue: work is lost on restart, and nothing schedules recovery across processes',
    );
    check('jobs.queues', 'skip', 'no durable queue to inspect');
  }

  // ---- object storage -----------------------------------------------------
  if (config.storage.driver === 'local') {
    check('storage', ...(await probeStorageRoot(config.storage.localRoot)));
  } else {
    check(
      'storage',
      'warn',
      'in-memory object store: every ingested document is lost on restart (production refuses this)',
    );
  }

  // ---- model provider -----------------------------------------------------
  if (config.ai.provider === 'anthropic' && config.ai.anthropic !== undefined) {
    const routing = createModelRouting(config.ai.models);
    check(
      'ai.provider',
      'pass',
      `anthropic; key present (${String(config.ai.anthropic.apiKey.length)} chars); fast=${routing.table.fast} standard=${routing.table.standard} deep=${routing.table.deep}`,
    );
    const probe = options.probe ?? probeAnthropic;
    const result = await probe({
      apiKey: config.ai.anthropic.apiKey,
      ...(config.ai.anthropic.baseUrl === undefined
        ? {}
        : { baseUrl: config.ai.anthropic.baseUrl }),
    });
    if (result.ok) {
      check(
        'ai.connectivity',
        'pass',
        `reachable; ${String(result.models)} model(s) visible to this key; ${String(result.latencyMs)} ms`,
      );
    } else {
      const status = result.status === undefined ? '' : ` (HTTP ${String(result.status)})`;
      check(
        'ai.connectivity',
        'fail',
        result.kind === 'unauthorized'
          ? `the provider refused the key${status}`
          : result.kind === 'unreachable'
            ? `the provider could not be reached: ${result.detail}`
            : `the provider refused the request${status}: ${result.detail}`,
      );
    }
  } else {
    check(
      'ai.provider',
      'warn',
      `${config.ai.provider}: no model runs, so nothing is analysed (production refuses this)`,
    );
    check('ai.connectivity', 'skip', 'no provider to reach');
  }

  // ---- secrets, authentication, mailbox ----------------------------------
  check(
    'secrets.key',
    config.secrets.key === undefined ? 'warn' : 'pass',
    config.secrets.key === undefined
      ? 'absent: no connector credential can be stored (production refuses this)'
      : `present (${String(config.secrets.key.length)} chars)`,
  );

  const jwks = config.auth.jwksUrl !== undefined;
  check(
    'auth',
    production && !jwks ? 'warn' : 'pass',
    `issuer=${config.auth.issuer} audience=${config.auth.audience} ${jwks ? 'JWKS' : 'HS256 shared secret'}${
      production && !jwks ? ' — an asymmetric JWKS issuer is expected in production' : ''
    }`,
  );

  check(
    'mailbox.driver',
    config.mailbox.driver === 'imap_smtp' ? 'pass' : 'warn',
    config.mailbox.driver === 'imap_smtp'
      ? 'imap_smtp (nothing is connected by this check; see `dolmir safety`)'
      : 'fake: the in-memory mailbox never sends (production refuses this)',
  );

  return { checks, ok: checks.every((item) => item.status !== 'fail') };
}

/**
 * Exists, is a directory, and takes a file. The root is not created here: a
 * missing root in production usually means a volume that was not mounted, and
 * creating one on the container's own disk would hide exactly that.
 */
async function probeStorageRoot(root: string): Promise<[CheckStatus, string]> {
  try {
    const info = await stat(root);
    if (!info.isDirectory()) return ['fail', `${root} exists and is not a directory`];
  } catch (error) {
    return [
      'fail',
      `${root} does not exist (${describe(error)}); create it — or mount the volume — writable by the runtime user`,
    ];
  }
  const probe = join(root, `.dolmir-preflight-${randomBytes(6).toString('hex')}`);
  const token = randomBytes(16).toString('hex');
  try {
    await writeFile(probe, token, { flag: 'wx' });
    const read = await readFile(probe, 'utf8');
    if (read !== token) return ['fail', `${root}: a file written there read back differently`];
    return ['pass', `${root} exists and is writable`];
  } catch (error) {
    return ['fail', `${root} is not writable by this user (${describe(error)})`];
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string')
    return error.code;
  return error instanceof Error ? error.message : String(error);
}
