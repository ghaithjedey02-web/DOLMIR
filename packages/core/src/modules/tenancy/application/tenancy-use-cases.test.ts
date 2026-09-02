import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../../kernel/clock.js';
import { noExecutionContext } from '../../../kernel/context.js';
import { newOrganizationId } from '../../../kernel/ids.js';
import { AuditTrail, InMemoryAuditLogRepository } from '../../audit/index.js';
import {
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryTenancyStore,
  InMemoryTransactionRunner,
  InMemoryUserRepository,
} from '../adapters/memory/in-memory-repositories.js';
import { ListUserOrganizations } from './list-user-organizations.js';
import { ProvisionOrganization } from './provision-organization.js';
import { ResolveTenantContext } from './resolve-tenant-context.js';

function harness() {
  const clock = new FixedClock();
  const store = new InMemoryTenancyStore(clock);
  const transactions = new InMemoryTransactionRunner();
  const auditLog = new InMemoryAuditLogRepository();
  const deps = {
    transactions,
    organizations: new InMemoryOrganizationRepository(store),
    users: new InMemoryUserRepository(store),
    memberships: new InMemoryMembershipRepository(store),
    audit: new AuditTrail({ repository: auditLog, clock, context: noExecutionContext }),
  };
  return {
    store,
    transactions,
    auditLog,
    provision: new ProvisionOrganization(deps),
    resolve: new ResolveTenantContext(deps),
    list: new ListUserOrganizations(deps),
  };
}

describe('ProvisionOrganization', () => {
  it('creates the organization, provisions the owner just-in-time and records the owner membership', async () => {
    const h = harness();
    const result = await h.provision.execute({
      organization: { slug: 'officina-rossi', name: 'Officina Rossi S.r.l.' },
      owner: { authSubject: 'auth|rossi', email: 'titolare@officina-rossi.example' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.organization.slug).toBe('officina-rossi');
    expect(result.value.owner.authSubject).toBe('auth|rossi');
    expect(result.value.membership).toMatchObject({ roleKey: 'owner', status: 'active' });
    expect(h.transactions.systemScopeReasons).toEqual(['provision_organization']);
    expect(h.auditLog.entries).toHaveLength(1);
    expect(h.auditLog.entries[0]).toMatchObject({
      organizationId: result.value.organization.id,
      action: 'organization.provisioned',
      actor: { type: 'USER', id: result.value.owner.id },
      target: { type: 'organization', id: result.value.organization.id },
    });
  });

  it('rejects invalid input as a value and never touches the store', async () => {
    const h = harness();
    const result = await h.provision.execute({
      organization: { slug: 'Not Valid!', name: '' },
      owner: { authSubject: 'x' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ORGANIZATION');
    expect(h.store.organizations.size).toBe(0);
  });

  it('refuses a taken slug with a conflict', async () => {
    const h = harness();
    const input = {
      organization: { slug: 'dup', name: 'Dup' },
      owner: { authSubject: 'auth|a' },
    };
    expect((await h.provision.execute(input)).ok).toBe(true);
    const second = await h.provision.execute(input);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('ORGANIZATION_SLUG_TAKEN');
  });

  it('reuses an existing user for a second organization', async () => {
    const h = harness();
    await h.provision.execute({
      organization: { slug: 'one', name: 'One' },
      owner: { authSubject: 'auth|a' },
    });
    await h.provision.execute({
      organization: { slug: 'two', name: 'Two' },
      owner: { authSubject: 'auth|a' },
    });
    expect(h.store.users.size).toBe(1);
    expect(h.store.memberships).toHaveLength(2);
  });
});

describe('ResolveTenantContext', () => {
  it('resolves a member inside the tenant scope', async () => {
    const h = harness();
    const provisioned = await h.provision.execute({
      organization: { slug: 'acme', name: 'ACME' },
      owner: { authSubject: 'auth|owner' },
    });
    if (!provisioned.ok) throw new Error('setup failed');
    const context = await h.resolve.execute({
      authSubject: 'auth|owner',
      organizationId: provisioned.value.organization.id,
    });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    expect(context.value).toEqual({
      organizationId: provisioned.value.organization.id,
      organizationSlug: 'acme',
      userId: provisioned.value.owner.id,
      roleKey: 'owner',
    });
    // The hot path never needs system scope.
    expect(h.transactions.systemScopeReasons).toEqual(['provision_organization']);
  });

  it('refuses non-members and unknown organizations with the same error', async () => {
    const h = harness();
    const a = await h.provision.execute({
      organization: { slug: 'a', name: 'A' },
      owner: { authSubject: 'auth|a' },
    });
    const b = await h.provision.execute({
      organization: { slug: 'b', name: 'B' },
      owner: { authSubject: 'auth|b' },
    });
    if (!a.ok || !b.ok) throw new Error('setup failed');

    const crossTenant = await h.resolve.execute({
      authSubject: 'auth|a',
      organizationId: b.value.organization.id,
    });
    const unknownOrg = await h.resolve.execute({
      authSubject: 'auth|a',
      organizationId: newOrganizationId(),
    });
    const unknownUser = await h.resolve.execute({
      authSubject: 'auth|nobody',
      organizationId: a.value.organization.id,
    });
    for (const outcome of [crossTenant, unknownOrg, unknownUser]) {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.code).toBe('NOT_A_MEMBER');
    }
  });
});

describe('ListUserOrganizations', () => {
  it('lists the organizations of a subject across tenants, in system scope', async () => {
    const h = harness();
    await h.provision.execute({
      organization: { slug: 'one', name: 'One' },
      owner: { authSubject: 'auth|a' },
    });
    await h.provision.execute({
      organization: { slug: 'two', name: 'Two' },
      owner: { authSubject: 'auth|a' },
    });
    await h.provision.execute({
      organization: { slug: 'other', name: 'Other' },
      owner: { authSubject: 'auth|b' },
    });
    const mine = await h.list.execute({ authSubject: 'auth|a' });
    expect(mine.map((m) => m.organization.slug).sort()).toEqual(['one', 'two']);
    expect(await h.list.execute({ authSubject: 'auth|nobody' })).toEqual([]);
    expect(h.transactions.systemScopeReasons.at(-1)).toBe('list_user_organizations');
  });
});
