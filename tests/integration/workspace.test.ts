import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AuditTrail,
  CORE_RULES,
  type OrganizationId,
  PersistedActionPolicy,
  PostgresAuditLogRepository,
  PostgresCompanyProfileRepository,
  PostgresCompanyRuleRepository,
  PostgresMembershipRepository,
  PostgresOrganizationRepository,
  PostgresPolicyOverrideRepository,
  PostgresTerminologyRepository,
  PostgresTransactionRunner,
  PostgresUserRepository,
  ProvisionOrganization,
  RuleRegistry,
  type TenantContext,
  WorkspaceConfiguration,
  clientOf,
  noExecutionContext,
  noopLogger,
  systemClock,
} from '@dolmir/core';

import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

describe('workspace configuration on PostgreSQL', () => {
  let db: TestDatabase;
  let transactions: PostgresTransactionRunner;
  let tenantA: TenantContext;
  let orgB: OrganizationId;
  let configuration: WorkspaceConfiguration;
  let policy: PersistedActionPolicy;

  beforeAll(async () => {
    db = await createTestDatabase();
    transactions = new PostgresTransactionRunner(db.appPool, noopLogger);
    const audit = new AuditTrail({
      repository: new PostgresAuditLogRepository(),
      clock: systemClock,
      context: noExecutionContext,
    });
    const provision = new ProvisionOrganization({
      transactions,
      organizations: new PostgresOrganizationRepository(),
      users: new PostgresUserRepository(),
      memberships: new PostgresMembershipRepository(),
      audit,
    });
    const a = await provision.execute({
      organization: { slug: 'a', name: 'A' },
      owner: { authSubject: 'auth|a' },
    });
    const b = await provision.execute({
      organization: { slug: 'b', name: 'B' },
      owner: { authSubject: 'auth|b' },
    });
    if (!a.ok || !b.ok) throw new Error('provisioning failed');
    tenantA = {
      organizationId: a.value.organization.id,
      organizationSlug: 'a',
      userId: a.value.owner.id,
      roleKey: 'owner',
    };
    orgB = b.value.organization.id;
    const registry = new RuleRegistry();
    for (const rule of CORE_RULES) registry.register(rule);
    const overrides = new PostgresPolicyOverrideRepository();
    configuration = new WorkspaceConfiguration({
      profiles: new PostgresCompanyProfileRepository(),
      rules: new PostgresCompanyRuleRepository(),
      terminology: new PostgresTerminologyRepository(),
      policyOverrides: overrides,
      ruleRegistry: registry,
      audit,
      clock: systemClock,
    });
    policy = new PersistedActionPolicy({ transactions, overrides });
  });

  afterAll(async () => {
    await db.drop();
  });

  it('stores profile, rules, terminology and overrides per tenant', async () => {
    await transactions.withTenant(tenantA.organizationId, async (scope) => {
      const profile = await configuration.updateProfile(
        scope,
        tenantA,
        { sector: 'meccanica', languages: ['it', 'en'] },
        'A S.r.l.',
      );
      expect(profile.ok && profile.value.version).toBe(1);
      expect(
        (await configuration.setRule(scope, tenantA, 'response_sla_hours', 24, 'promessa')).ok,
      ).toBe(true);
      expect((await configuration.setRule(scope, tenantA, 'response_sla_hours', 8, null)).ok).toBe(
        true,
      );
      expect(
        (
          await configuration.upsertTerm(scope, tenantA, {
            term: 'RdO',
            meaning: 'Richiesta di offerta',
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await configuration.setPolicyOverride(
            scope,
            tenantA,
            'effect',
            'act',
            'AUTO_EXECUTE',
            'test',
          )
        ).ok,
      ).toBe(true);
    });
    const contextA = await transactions.withTenant(tenantA.organizationId, (scope) =>
      configuration.context(scope, 'fallback'),
    );
    expect(contextA.profile).toMatchObject({
      legalName: 'A S.r.l.',
      sector: 'meccanica',
      languages: ['it', 'en'],
      version: 1,
    });
    expect(contextA.rules).toEqual({ response_sla_hours: 8 });
    expect(contextA.terminology.map((t) => t.termKey)).toEqual(['rdo']);
    expect(
      await policy.resolve(tenantA.organizationId, { name: 'send_reply', effect: 'act' }),
    ).toMatchObject({ level: 'AUTO_EXECUTE', source: 'tenant_effect' });

    const contextB = await transactions.withTenant(orgB, (scope) =>
      configuration.context(scope, 'B fallback'),
    );
    expect(contextB.profile.legalName).toBe('B fallback');
    expect(contextB.rules).toEqual({});
    expect(contextB.terminology).toEqual([]);
    expect(await policy.resolve(orgB, { name: 'send_reply', effect: 'act' })).toMatchObject({
      level: 'REQUIRE_APPROVAL',
      source: 'default',
    });
  });

  it('keeps rule history append-only and readable', async () => {
    const history = await transactions.withTenant(tenantA.organizationId, (scope) =>
      clientOf(scope).query(
        'SELECT version, value FROM public.company_rules WHERE key = $1 ORDER BY version',
        ['response_sla_hours'],
      ),
    );
    expect(history.rows).toEqual([
      { version: 1, value: 24 },
      { version: 2, value: 8 },
    ]);
    await expect(
      transactions.withTenant(tenantA.organizationId, (scope) =>
        clientOf(scope).query("UPDATE public.company_rules SET value = '1'::jsonb WHERE key = $1", [
          'response_sla_hours',
        ]),
      ),
    ).rejects.toMatchObject({ category: 'forbidden' });
  });
});
