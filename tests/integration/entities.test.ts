import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ActorType,
  AuditTrail,
  EntityResolver,
  ImportEntities,
  type OrganizationId,
  PostgresAuditLogRepository,
  PostgresEntityAliasRepository,
  PostgresEntityRepository,
  PostgresMembershipRepository,
  PostgresOrganizationRepository,
  PostgresTransactionRunner,
  PostgresUserRepository,
  ProvisionOrganization,
  noExecutionContext,
  noopLogger,
  systemClock,
} from '@dolmir/core';

import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

describe('entities on PostgreSQL', () => {
  let db: TestDatabase;
  let transactions: PostgresTransactionRunner;
  let orgA: OrganizationId;
  let orgB: OrganizationId;
  const entities = new PostgresEntityRepository();
  const aliases = new PostgresEntityAliasRepository();
  const actor = { type: ActorType.USER, id: 'admin' };
  let importer: ImportEntities;
  const resolver = new EntityResolver({ entities, aliases });

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
    orgA = a.value.organization.id;
    orgB = b.value.organization.id;
    importer = new ImportEntities({ transactions, entities, aliases, audit });
  });

  afterAll(async () => {
    await db.drop();
  });

  it('imports entities with aliases and resolves them inside the tenant only', async () => {
    const imported = await importer.execute(orgA, actor, {
      source: 'test.csv',
      rows: [
        {
          kind: 'customer',
          name: 'Officine Meccaniche Rossi S.r.l.',
          code: 'C0042',
          email: 'acquisti@officine-rossi.it',
          vat: 'IT01234567890',
        },
        {
          kind: 'customer',
          name: 'Rossi Impianti S.p.A.',
          code: 'C0043',
          email: 'acquisti@rossi-impianti.it',
        },
      ],
    });
    expect(imported.ok && imported.value).toMatchObject({ created: 2, updated: 0 });

    const inA = await transactions.withTenant(orgA, (scope) =>
      resolver.resolve(scope, { kind: 'customer', email: 'nuovo.contatto@officine-rossi.it' }),
    );
    expect(inA.kind).toBe('RESOLVED');
    if (inA.kind === 'RESOLVED') expect(inA.match.entity.code).toBe('C0042');

    const inB = await transactions.withTenant(orgB, (scope) =>
      resolver.resolve(scope, { kind: 'customer', email: 'acquisti@officine-rossi.it' }),
    );
    expect(inB.kind).toBe('UNRESOLVED');
    const listedByB = await transactions.withTenant(orgB, (scope) =>
      entities.list(scope, { limit: 10 }),
    );
    expect(listedByB).toEqual([]);
  });

  it('uses trigram similarity for misspelled names and reports ambiguity', async () => {
    const fuzzy = await transactions.withTenant(orgA, (scope) =>
      resolver.resolve(scope, { kind: 'customer', name: 'Officine Mecaniche Rosi' }),
    );
    expect(['RESOLVED', 'AMBIGUOUS']).toContain(fuzzy.kind);
    if (fuzzy.kind === 'RESOLVED') {
      expect(fuzzy.match.entity.code).toBe('C0042');
      expect(fuzzy.match.reasons[0]?.kind).toBe('name_similarity');
    }
    const ambiguous = await transactions.withTenant(orgA, (scope) =>
      resolver.resolve(scope, { kind: 'customer', name: 'Rossi' }),
    );
    expect(ambiguous.kind).toBe('AMBIGUOUS');
  });

  it('keeps aliases unique per tenant and lets another tenant reuse them', async () => {
    const inB = await importer.execute(orgB, actor, {
      source: 'test.csv',
      rows: [
        {
          kind: 'customer',
          name: 'Officine Meccaniche Rossi S.r.l.',
          code: 'C0042',
          email: 'acquisti@officine-rossi.it',
        },
      ],
    });
    expect(inB.ok && inB.value.created).toBe(1);

    const duplicate = await transactions.withTenant(orgA, async (scope) => {
      const [first, second] = await entities.list(scope, { limit: 2, kind: 'customer' });
      if (first === undefined || second === undefined) throw new Error('expected two customers');
      return aliases
        .add(scope, { entityId: second.id, kind: 'email', value: 'acquisti@officine-rossi.it' })
        .catch((error: unknown) => error);
    });
    expect(duplicate).toMatchObject({ code: 'UNIQUE_VIOLATION' });
  });
});
