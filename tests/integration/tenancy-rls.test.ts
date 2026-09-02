import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ListUserOrganizations,
  PostgresMembershipRepository,
  PostgresOrganizationRepository,
  PostgresTransactionRunner,
  PostgresUserRepository,
  ProvisionOrganization,
  ResolveTenantContext,
  clientOf,
  noopLogger,
  type Organization,
  type User,
} from '@dolmir/core';

import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

/**
 * Tenant isolation is a database property (ADR-0005). These tests use the
 * real runtime role against a freshly migrated database and prove:
 *   - a tenant sees and writes only its own rows;
 *   - a transaction without a scope sees nothing and can insert nothing;
 *   - system scope is the only cross-tenant path, and it is explicit.
 */
describe('tenancy under Row-Level Security', () => {
  let db: TestDatabase;
  let transactions: PostgresTransactionRunner;
  const organizations = new PostgresOrganizationRepository();
  const users = new PostgresUserRepository();
  const memberships = new PostgresMembershipRepository();
  let orgA: Organization;
  let orgB: Organization;
  let ownerA: User;

  beforeAll(async () => {
    db = await createTestDatabase();
    transactions = new PostgresTransactionRunner(db.appPool, noopLogger);
    const provision = new ProvisionOrganization({
      transactions,
      organizations,
      users,
      memberships,
    });
    const a = await provision.execute({
      organization: { slug: 'officina-a', name: 'Officina A' },
      owner: { authSubject: 'auth|owner-a', email: 'a@example.test' },
    });
    const b = await provision.execute({
      organization: { slug: 'officina-b', name: 'Officina B' },
      owner: { authSubject: 'auth|owner-b', email: 'b@example.test' },
    });
    if (!a.ok || !b.ok) throw new Error('provisioning failed');
    orgA = a.value.organization;
    orgB = b.value.organization;
    ownerA = a.value.owner;
  });

  afterAll(async () => {
    await db.drop();
  });

  it('the runtime role cannot bypass RLS and is not a superuser', async () => {
    const result = await db.appPool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    expect(result.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it('a tenant sees only its own organization, memberships and members', async () => {
    await transactions.withTenant(orgA.id, async (scope) => {
      expect(await organizations.findById(scope, orgA.id)).toMatchObject({ slug: 'officina-a' });
      expect(await organizations.findById(scope, orgB.id)).toBeUndefined();
      expect(await organizations.findBySlug(scope, 'officina-b')).toBeUndefined();

      const visibleRows = await clientOf(scope).query('SELECT slug FROM public.organizations');
      expect(visibleRows.rows).toEqual([{ slug: 'officina-a' }]);

      expect(await users.findByAuthSubject(scope, 'auth|owner-a')).toBeDefined();
      expect(await users.findByAuthSubject(scope, 'auth|owner-b')).toBeUndefined();

      const membershipRows = await clientOf(scope).query(
        'SELECT organization_id FROM public.memberships',
      );
      expect(membershipRows.rows).toEqual([{ organization_id: orgA.id }]);
    });
  });

  it('a tenant cannot write rows for another tenant', async () => {
    await expect(
      transactions.withTenant(orgA.id, async (scope) => {
        await memberships.insert(scope, {
          organizationId: orgB.id,
          userId: ownerA.id,
          roleKey: 'viewer',
        });
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_ACCESS_DENIED', category: 'forbidden' });

    await expect(
      transactions.withTenant(orgA.id, async (scope) => {
        await clientOf(scope).query('UPDATE public.organizations SET name = $1 WHERE id = $2', [
          'Hijacked',
          orgB.id,
        ]);
      }),
    ).resolves.toBeUndefined(); // the UPDATE matches no visible row: zero rows changed, no leak

    await transactions.withSystemScope('test_verification', async (scope) => {
      expect(await organizations.findById(scope, orgB.id)).toMatchObject({ name: 'Officina B' });
    });
  });

  it('a transaction without any scope sees nothing and cannot insert', async () => {
    const client = await db.appPool.connect();
    try {
      await client.query('BEGIN');
      const rows = await client.query('SELECT count(*)::int AS n FROM public.organizations');
      expect(rows.rows[0]).toEqual({ n: 0 });
      const members = await client.query('SELECT count(*)::int AS n FROM public.memberships');
      expect(members.rows[0]).toEqual({ n: 0 });
      const people = await client.query('SELECT count(*)::int AS n FROM public.users');
      expect(people.rows[0]).toEqual({ n: 0 });
      await expect(
        client.query("INSERT INTO public.organizations (slug, name) VALUES ('ghost', 'Ghost')"),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('the tenant setting is transaction-local: the next transaction on the same connection is clean', async () => {
    const client = await db.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('dolmir.tenant_id', $1, true), set_config('dolmir.scope', 'tenant', true)",
        [orgA.id],
      );
      const inside = await client.query('SELECT count(*)::int AS n FROM public.organizations');
      expect(inside.rows[0]).toEqual({ n: 1 });
      await client.query('COMMIT');
      const after = await client.query('SELECT count(*)::int AS n FROM public.organizations');
      expect(after.rows[0]).toEqual({ n: 0 });
    } finally {
      client.release();
    }
  });

  it('resolves tenant context for members only, and lists a user’s organizations in system scope', async () => {
    const resolve = new ResolveTenantContext({ transactions, organizations, users, memberships });
    const ok = await resolve.execute({ authSubject: 'auth|owner-a', organizationId: orgA.id });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toMatchObject({ organizationSlug: 'officina-a', roleKey: 'owner' });

    const cross = await resolve.execute({ authSubject: 'auth|owner-a', organizationId: orgB.id });
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.error.code).toBe('NOT_A_MEMBER');

    const list = new ListUserOrganizations({ transactions, organizations, users, memberships });
    const mine = await list.execute({ authSubject: 'auth|owner-a' });
    expect(mine.map((m) => m.organization.slug)).toEqual(['officina-a']);
  });

  it('translates constraint violations into the platform vocabulary', async () => {
    await expect(
      transactions.withSystemScope('test_duplicate_slug', async (scope) => {
        await organizations.insert(scope, { slug: 'officina-a', name: 'Duplicate' });
      }),
    ).rejects.toMatchObject({ code: 'UNIQUE_VIOLATION', category: 'conflict' });

    await expect(
      transactions.withSystemScope('test_bad_slug', async (scope) => {
        await clientOf(scope).query(
          "INSERT INTO public.organizations (slug, name) VALUES ('Bad Slug', 'x')",
        );
      }),
    ).rejects.toMatchObject({ code: 'CHECK_VIOLATION', category: 'validation' });
  });
});
