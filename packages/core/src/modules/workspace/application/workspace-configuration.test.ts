import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../../kernel/clock.js';
import { noExecutionContext } from '../../../kernel/context.js';
import { newOrganizationId, newUserId } from '../../../kernel/ids.js';
import type { TenantScope } from '../../../kernel/scope.js';
import type { TenantContext } from '../../../kernel/tenant.js';
import { AuditTrail, InMemoryAuditLogRepository } from '../../audit/index.js';
import { InMemoryTransactionRunner } from '../../tenancy/index.js';
import {
  InMemoryCompanyProfileRepository,
  InMemoryCompanyRuleRepository,
  InMemoryPolicyOverrideRepository,
  InMemoryTerminologyRepository,
  InMemoryWorkspaceStore,
} from '../adapters/memory/in-memory-workspace-repositories.js';
import { CORE_RULES, RuleRegistry } from '../domain/company-rule.js';
import { PersistedActionPolicy } from './persisted-action-policy.js';
import { WorkspaceConfiguration } from './workspace-configuration.js';

const organizationId = newOrganizationId();
const userId = newUserId();
const scope: TenantScope = { kind: 'tenant', tenantId: organizationId };
const tenant: TenantContext = {
  organizationId,
  organizationSlug: 'acme',
  userId,
  roleKey: 'admin',
};

function setup() {
  const clock = new FixedClock(new Date('2026-09-03T10:00:00.000Z'));
  const store = new InMemoryWorkspaceStore();
  const auditRepository = new InMemoryAuditLogRepository();
  const registry = new RuleRegistry();
  for (const rule of CORE_RULES) registry.register(rule);
  const overrides = new InMemoryPolicyOverrideRepository(store);
  const configuration = new WorkspaceConfiguration({
    profiles: new InMemoryCompanyProfileRepository(store),
    rules: new InMemoryCompanyRuleRepository(store),
    terminology: new InMemoryTerminologyRepository(store),
    policyOverrides: overrides,
    ruleRegistry: registry,
    audit: new AuditTrail({ repository: auditRepository, clock, context: noExecutionContext }),
    clock,
  });
  const policy = new PersistedActionPolicy({
    transactions: new InMemoryTransactionRunner(),
    overrides,
  });
  return { clock, store, auditRepository, registry, configuration, policy };
}

describe('WorkspaceConfiguration', () => {
  it('serves defaults until a profile is saved, then the saved profile with a version', async () => {
    const { configuration, auditRepository } = setup();
    const before = await configuration.context(scope, 'Officina Demo');
    expect(before.profile).toMatchObject({
      legalName: 'Officina Demo',
      languages: ['it'],
      timezone: 'Europe/Rome',
      version: 0,
    });
    const updated = await configuration.updateProfile(
      scope,
      tenant,
      {
        sector: 'lavorazioni meccaniche',
        languages: ['it', 'en'],
        signature: 'Ufficio Commerciale',
      },
      'Officina Demo',
    );
    expect(updated.ok && updated.value).toMatchObject({
      sector: 'lavorazioni meccaniche',
      version: 1,
      updatedBy: userId,
    });
    const after = await configuration.context(scope, 'ignored');
    expect(after.profile.legalName).toBe('Officina Demo');
    expect(auditRepository.entries.map((e) => e.action)).toEqual(['workspace.profile_updated']);
    const invalid = await configuration.updateProfile(
      scope,
      tenant,
      { languages: ['italiano'] },
      'x',
    );
    expect(!invalid.ok && invalid.error.code).toBe('INVALID_PROFILE');
  });

  it('versions rules, validates them against their definitions and exposes current values', async () => {
    const { configuration } = setup();
    const first = await configuration.setRule(
      scope,
      tenant,
      'response_sla_hours',
      24,
      'Promessa commerciale',
    );
    expect(first.ok && first.value.version).toBe(1);
    const second = await configuration.setRule(scope, tenant, 'response_sla_hours', 8, null);
    expect(second.ok && second.value.version).toBe(2);
    const language = await configuration.setRule(scope, tenant, 'reply_language', 'it', null);
    expect(language.ok).toBe(true);

    const invalid = await configuration.setRule(
      scope,
      tenant,
      'response_sla_hours',
      'domani',
      null,
    );
    expect(!invalid.ok && invalid.error.code).toBe('INVALID_RULE_VALUE');
    const unknown = await configuration.setRule(scope, tenant, 'discount_policy', 10, null);
    expect(!unknown.ok && unknown.error.code).toBe('UNKNOWN_RULE');

    const context = await configuration.context(scope, 'x');
    expect(context.rules).toEqual({ response_sla_hours: 8, reply_language: 'it' });

    const unset = await configuration.setRule(
      scope,
      tenant,
      'reply_language',
      null,
      'ora decidono gli operatori',
    );
    expect(unset.ok && unset.value.version).toBe(2);
    expect((await configuration.context(scope, 'x')).rules).toEqual({ response_sla_hours: 8 });
  });

  it('lets a system register its own rule definitions', async () => {
    const { configuration, registry } = setup();
    registry.register({
      key: 'commercial_inbox.acknowledge_within_hours',
      description: 'x',
      schema: (await import('zod')).z.number().int().min(1),
      owner: 'commercial_inbox',
    });
    const set = await configuration.setRule(
      scope,
      tenant,
      'commercial_inbox.acknowledge_within_hours',
      4,
      null,
    );
    expect(set.ok).toBe(true);
    expect(() =>
      registry.register({
        key: 'reply_language',
        description: 'dup',
        schema: registry.get('reply_language')!.schema,
        owner: 'x',
      }),
    ).toThrow(/already defined/);
  });

  it('keeps terminology per company, upserting by normalised term', async () => {
    const { configuration } = setup();
    await configuration.upsertTerm(scope, tenant, {
      term: 'RdO',
      meaning: 'Richiesta di offerta: un cliente chiede un preventivo.',
      examples: ['Vi inviamo RdO per...'],
    });
    const again = await configuration.upsertTerm(scope, tenant, {
      term: 'rdo',
      meaning: 'Richiesta di offerta.',
    });
    expect(again.ok && again.value.termKey).toBe('rdo');
    const context = await configuration.context(scope, 'x');
    expect(context.terminology).toHaveLength(1);
    expect(context.terminology[0]?.meaning).toBe('Richiesta di offerta.');
    const off = await configuration.upsertTerm(scope, tenant, {
      term: 'RdO',
      meaning: 'x',
      active: false,
    });
    expect(off.ok).toBe(true);
    expect((await configuration.context(scope, 'x')).terminology).toEqual([]);
  });

  it('persists action-policy overrides that the executor policy resolves tool → effect → default', async () => {
    const { configuration, policy, auditRepository } = setup();
    expect(
      await policy.resolve(organizationId, { name: 'send_reply', effect: 'act' }),
    ).toMatchObject({ level: 'REQUIRE_APPROVAL', source: 'default' });
    const byEffect = await configuration.setPolicyOverride(
      scope,
      tenant,
      'effect',
      'act',
      'SUGGEST',
      'Solo suggerimenti per ora',
    );
    expect(byEffect.ok).toBe(true);
    expect(
      await policy.resolve(organizationId, { name: 'send_reply', effect: 'act' }),
    ).toMatchObject({ level: 'SUGGEST', source: 'tenant_effect' });
    await configuration.setPolicyOverride(
      scope,
      tenant,
      'tool',
      'send_reply',
      'REQUIRE_APPROVAL',
      null,
    );
    expect(
      await policy.resolve(organizationId, { name: 'send_reply', effect: 'act' }),
    ).toMatchObject({ level: 'REQUIRE_APPROVAL', source: 'tenant_tool' });
    await configuration.setPolicyOverride(scope, tenant, 'tool', 'send_reply', null, null);
    expect(
      await policy.resolve(organizationId, { name: 'send_reply', effect: 'act' }),
    ).toMatchObject({ level: 'SUGGEST', source: 'tenant_effect' });
    const invalid = await configuration.setPolicyOverride(
      scope,
      tenant,
      'effect',
      'delete_everything',
      'AUTO_EXECUTE',
      null,
    );
    expect(!invalid.ok && invalid.error.code).toBe('INVALID_POLICY_OVERRIDE');
    expect(auditRepository.entries.map((e) => e.action)).toEqual([
      'policy.override_set',
      'policy.override_set',
      'policy.override_cleared',
    ]);
  });
});
