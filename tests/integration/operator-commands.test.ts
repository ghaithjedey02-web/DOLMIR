import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type AnthropicProbeResult,
  FAKE_MAILBOX_PROVIDER,
  PgBossJobQueue,
  RECOVERY_CRON,
  type TenantContext,
  clientOf,
  inspectJobQueue,
  installJobQueue,
  loadConfig,
  mailboxPollJob,
  noopLogger,
  recoverExecutionsJob,
} from '@dolmir/core';
import {
  type Container,
  PLATFORM_JOBS,
  createContainer,
  runPreflight,
  runSafety,
} from '@dolmir/api';

import { adminUrl, createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

/**
 * The two operator commands, against a real database, in the situations they
 * exist to tell apart.
 *
 * `preflight` is asked before and after the queue is installed, with a storage
 * root that exists and one that does not, with a provider that answers and one
 * that refuses the key, and as the superuser the runtime must never be.
 * `safety` is asked on an empty deployment, after a tenant gains a mailbox,
 * after that tenant is given AUTO_EXECUTE, after it is taken away again, and
 * with a mailbox poll scheduled — the one condition it is most important to
 * catch. Nothing is mocked but the network call to the model provider, which
 * is replaced so nothing leaves the machine.
 */
const SCHEMA = 'dolmir_jobs';
const PLACEHOLDER_API_KEY = 'sk-ant-test-placeholder-never-sent';
const MAILBOX_PASSWORD = 'credential-that-must-never-be-printed';

let db: TestDatabase;
let objectRoot: string;
let container: Container;
const open: Container[] = [];

function configure(overrides: Record<string, string> = {}): Container {
  const config = loadConfig({
    DOLMIR_ENV: 'test',
    DOLMIR_DATABASE_URL: db.appUrl,
    DOLMIR_DATABASE_OWNER_URL: db.ownerUrl,
    DOLMIR_AUTH_ISSUER: 'http://localhost/dev-auth',
    DOLMIR_AUTH_AUDIENCE: 'dolmir',
    DOLMIR_AUTH_HS256_SECRET: 'test-only-secret-value-at-least-32-chars',
    DOLMIR_SECRETS_KEY: Buffer.alloc(32, 9).toString('base64'),
    DOLMIR_JOBS_DRIVER: 'pg-boss',
    DOLMIR_JOBS_SCHEMA: SCHEMA,
    DOLMIR_STORAGE_DRIVER: 'local',
    DOLMIR_STORAGE_LOCAL_ROOT: objectRoot,
    DOLMIR_MAILBOX_DRIVER: 'fake',
    DOLMIR_AI_PROVIDER: 'fake',
    ...overrides,
  });
  if (!config.ok) throw new Error(config.error.message);
  const created = createContainer(config.value, { logger: noopLogger });
  open.push(created);
  return created;
}

beforeAll(async () => {
  db = await createTestDatabase();
  objectRoot = await mkdtemp(join(tmpdir(), 'dolmir-preflight-'));
  container = configure();
}, 60_000);

afterAll(async () => {
  for (const item of open) await item.close();
  await db.drop();
  await rm(objectRoot, { recursive: true, force: true });
});

const byName = (report: { checks: readonly { name: string; status: string; detail: string }[] }) =>
  new Map(report.checks.map((check) => [check.name, check]));

describe('dolmir preflight', () => {
  it('fails before the queue is installed, and says what to run', async () => {
    const report = await runPreflight(container);
    const checks = byName(report);

    expect(report.ok).toBe(false);
    expect(checks.get('database')).toMatchObject({ status: 'pass' });
    expect(checks.get('database')?.detail).toContain('role=dolmir_app');
    expect(checks.get('database')?.detail).toContain('NOBYPASSRLS');
    expect(checks.get('migrations')).toMatchObject({ status: 'pass' });
    expect(checks.get('jobs.queues')).toMatchObject({ status: 'fail' });
    expect(checks.get('jobs.queues')?.detail).toContain('dolmir jobs:install');
    expect(checks.get('storage')).toMatchObject({ status: 'pass' });
    // A test configuration is described as one, not failed for being one.
    expect(checks.get('configuration')).toMatchObject({ status: 'warn' });
    expect(checks.get('ai.provider')).toMatchObject({ status: 'warn' });
    expect(checks.get('ai.connectivity')).toMatchObject({ status: 'skip' });
  });

  it('reads the queue back exactly as installed, and changes nothing itself', async () => {
    const before = await inspectJobQueue(container.pool, { schema: SCHEMA, jobs: PLATFORM_JOBS });
    expect(before.schemaPresent).toBe(false);
    expect(before.queues.every((queue) => !queue.present && !queue.ok)).toBe(true);
    expect(before.schedules).toEqual([]);

    await installJobQueue({
      ownerConnectionString: db.ownerUrl,
      schema: SCHEMA,
      runtimeRole: 'dolmir_app',
      jobs: PLATFORM_JOBS,
      logger: noopLogger,
    });

    const after = await inspectJobQueue(container.pool, { schema: SCHEMA, jobs: PLATFORM_JOBS });
    expect(after.schemaPresent).toBe(true);
    expect(after.queues.map((queue) => queue.name)).toEqual(PLATFORM_JOBS.map((job) => job.name));
    expect(after.queues.every((queue) => queue.present && queue.ok)).toBe(true);
    expect(
      after.queues.find((queue) => queue.name === 'cases.execute_recommendation')?.policy,
    ).toBe('exclusive');
    expect(after.schedules).toEqual([]);

    const report = await runPreflight(container);
    expect(report.ok).toBe(true);
    expect(byName(report).get('jobs.queues')?.detail).toContain(
      'cases.execute_recommendation (exclusive)',
    );
  }, 60_000);

  it('fails a storage root that does not exist rather than creating one', async () => {
    const missing = configure({ DOLMIR_STORAGE_LOCAL_ROOT: join(objectRoot, 'not-mounted') });
    const report = await runPreflight(missing);
    const storage = byName(report).get('storage');
    expect(storage).toMatchObject({ status: 'fail' });
    expect(storage?.detail).toContain('does not exist');
    expect(storage?.detail).toContain('mount the volume');
    expect(report.ok).toBe(false);
  });

  it('leaves no probe file behind in a root it found writable', async () => {
    await runPreflight(container);
    const { readdir } = await import('node:fs/promises');
    const left = (await readdir(objectRoot)).filter((name) => name.startsWith('.dolmir-preflight'));
    expect(left).toEqual([]);
  });

  it('reports the provider reachable or not, and never repeats the key', async () => {
    const withModel = configure({
      DOLMIR_AI_PROVIDER: 'anthropic',
      DOLMIR_AI_ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY,
    });

    const reachable = await runPreflight(withModel, {
      probe: async (): Promise<AnthropicProbeResult> => ({ ok: true, latencyMs: 12, models: 3 }),
    });
    expect(byName(reachable).get('ai.provider')).toMatchObject({ status: 'pass' });
    expect(byName(reachable).get('ai.provider')?.detail).toContain('key present (34 chars)');
    expect(byName(reachable).get('ai.connectivity')).toMatchObject({ status: 'pass' });
    expect(byName(reachable).get('ai.connectivity')?.detail).toContain('3 model(s)');
    expect(reachable.ok).toBe(true);

    const refused = await runPreflight(withModel, {
      probe: async (): Promise<AnthropicProbeResult> => ({
        ok: false,
        kind: 'unauthorized',
        status: 401,
        detail: 'invalid x-api-key',
      }),
    });
    expect(byName(refused).get('ai.connectivity')).toMatchObject({ status: 'fail' });
    expect(byName(refused).get('ai.connectivity')?.detail).toContain('refused the key');
    expect(refused.ok).toBe(false);

    for (const report of [reachable, refused]) {
      expect(JSON.stringify(report)).not.toContain(PLACEHOLDER_API_KEY);
      expect(JSON.stringify(report)).not.toContain(db.appUrl);
    }
  });

  it('fails a runtime connection that could bypass row-level security', async () => {
    // The harness's admin connection is a superuser. Pointed at the migrated
    // test database it reaches everything — which is exactly why it must fail.
    const superuser = new URL(adminUrl());
    superuser.pathname = `/${db.name}`;
    const asSuperuser = configure({ DOLMIR_DATABASE_URL: superuser.toString() });
    const report = await runPreflight(asSuperuser);
    const database = byName(report).get('database');
    expect(database).toMatchObject({ status: 'fail' });
    expect(database?.detail).toContain('bypass row-level security');
    expect(report.ok).toBe(false);
  });
});

describe('dolmir safety', () => {
  let owner: TenantContext;
  let sendTool: string;

  beforeAll(async () => {
    const provisioned = await container.tenancy.provision.execute({
      organization: { slug: 'alfa', name: 'Alfa Meccanica S.r.l.' },
      owner: { authSubject: 'auth|owner' },
    });
    if (!provisioned.ok) throw provisioned.error;
    owner = {
      organizationId: provisioned.value.organization.id,
      organizationSlug: 'alfa',
      userId: provisioned.value.owner.id,
      roleKey: 'owner',
    };
    const acting = container.ai.tools.describe().filter((tool) => tool.effect === 'act');
    expect(acting.map((tool) => tool.name)).toEqual(['send_mailbox_reply']);
    sendTool = acting[0]!.name;
  });

  it('finds an empty deployment safe, and says why', async () => {
    const report = await runSafety(container);
    const text = report.sections.map((s) => `${s.title}\n${s.lines.join('\n')}`).join('\n');

    expect(report.ok).toBe(true);
    expect(report.unsafe).toEqual([]);
    expect(text).toContain('act      → REQUIRE_APPROVAL');
    expect(text).toContain('AUTO_EXECUTE is not the default for any effect');
    expect(text).toContain('decisions:approve');
    expect(text).toContain('connections:manage');
    expect(text).toContain('send_mailbox_reply  (requires ai:invoke)');
    expect(text).toContain('none: every tenant runs on the code defaults');
    expect(text).toContain('none: no reply can be drafted or sent for any tenant');
  });

  it('shows a tenant with a mailbox as able to send only after a human approves', async () => {
    const created = await container.connectors.manage.create(owner, {
      capability: 'mailbox',
      provider: FAKE_MAILBOX_PROVIDER,
      displayName: 'Vendite',
      settings: { mailbox: 'INBOX' },
      credentials: { user: 'vendite@alfa.test', pass: MAILBOX_PASSWORD },
    });
    if (!created.ok) throw created.error;

    const report = await runSafety(container);
    const text = report.sections.flatMap((s) => s.lines).join('\n');

    expect(report.ok).toBe(true);
    expect(text).toContain(`organisation ${owner.organizationId}  connection ${created.value.id}`);
    expect(text).toContain(
      `${sendTool} → REQUIRE_APPROVAL (default): runs only after a human approves`,
    );
    // Identity and provider only: never a credential, never even the settings.
    expect(text).not.toContain(MAILBOX_PASSWORD);
    expect(text).not.toContain('vendite@alfa.test');
    expect(text).not.toContain('INBOX');
  });

  it('flags AUTO_EXECUTE the moment a tenant is given it, and clears when it is taken away', async () => {
    const set = await container.transactions.withTenant(owner.organizationId, (scope) =>
      container.workspace.configuration.setPolicyOverride(
        scope,
        owner,
        'tool',
        sendTool,
        'AUTO_EXECUTE',
        'test: what the report must catch',
      ),
    );
    if (!set.ok) throw set.error;

    const unsafe = await runSafety(container);
    expect(unsafe.ok).toBe(false);
    expect(unsafe.unsafe.join('\n')).toContain(`organisation ${owner.organizationId}`);
    expect(unsafe.unsafe.join('\n')).toContain('AUTO_EXECUTE');
    expect(unsafe.sections.flatMap((s) => s.lines).join('\n')).toContain('RUNS WITHOUT A HUMAN');

    const cleared = await container.transactions.withTenant(owner.organizationId, (scope) =>
      container.workspace.configuration.setPolicyOverride(
        scope,
        owner,
        'tool',
        sendTool,
        null,
        null,
      ),
    );
    if (!cleared.ok) throw cleared.error;

    const safe = await runSafety(container);
    expect(safe.ok).toBe(true);
    expect(safe.sections.flatMap((s) => s.lines).join('\n')).toContain('cleared → default applies');
  });

  it('reports what the queue would run on its own, and flags a scheduled mailbox poll', async () => {
    // A real pg-boss instance as the runtime role, so the schedule table holds
    // exactly what a running deployment's would.
    const queue = new PgBossJobQueue({
      connectionString: db.appUrl,
      schema: SCHEMA,
      logger: noopLogger,
    });
    await queue.start();
    try {
      await queue.schedule(recoverExecutionsJob, RECOVERY_CRON, {});
      const recoveryOnly = await runSafety(container);
      const lines = recoveryOnly.sections.flatMap((s) => s.lines).join('\n');
      expect(recoveryOnly.ok).toBe(true);
      expect(lines).toContain(`cases.recover_executions  ${RECOVERY_CRON}`);

      // Never done in a deployment. In this disposable database, with no
      // worker started, it proves the detector catches the one thing this
      // phase must not have.
      await queue.schedule(
        mailboxPollJob,
        '*/10 * * * *',
        { tenantId: owner.organizationId, connectionId: '00000000-0000-4000-8000-000000000001' },
        { key: 'test' },
      );
      const polling = await runSafety(container);
      expect(polling.ok).toBe(false);
      expect(polling.unsafe.join('\n')).toContain('mailbox.poll');

      await queue.unschedule(mailboxPollJob, 'test');
      expect((await runSafety(container)).ok).toBe(true);
    } finally {
      await queue.stop();
    }
  }, 60_000);

  it('is read-only, and leaves exactly the audit trace the platform requires of a system scope', async () => {
    // Row-level security is forced for the owner too, so an unscoped
    // connection sees nothing and would make "unchanged" vacuously true. The
    // counts are taken inside a system scope of their own — which is itself
    // audited, under a different reason, so the trace assertion stays exact.
    const count = async (sql: string): Promise<number> =>
      container.transactions.withSystemScope('test: count rows', async (scope) => {
        const result = await clientOf(scope).query<{ n: string }>(sql);
        return Number(result.rows[0]?.n ?? '0');
      });
    const overrides = 'SELECT count(*)::text AS n FROM public.policy_overrides';
    const connections = 'SELECT count(*)::text AS n FROM public.tenant_connections';
    const traces = `SELECT count(*)::text AS n FROM public.audit_log
                     WHERE action = 'system_scope.opened' AND details->>'reason' = 'safety_posture_report'`;

    const overridesBefore = await count(overrides);
    const connectionsBefore = await count(connections);
    const tracesBefore = await count(traces);
    // The earlier tests created one connection and one (later cleared) override;
    // seeing them proves the counts are looking through the policy, not at 0.
    expect(connectionsBefore).toBe(1);
    expect(overridesBefore).toBe(1);
    expect(tracesBefore).toBeGreaterThan(0);

    await runSafety(container);

    expect(await count(overrides)).toBe(overridesBefore);
    expect(await count(connections)).toBe(connectionsBefore);
    expect(await count(traces)).toBe(tracesBefore + 1);
  });
});
