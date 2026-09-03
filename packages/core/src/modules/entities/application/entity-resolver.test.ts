import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../../kernel/clock.js';
import { ActorType, noExecutionContext } from '../../../kernel/context.js';
import { newOrganizationId } from '../../../kernel/ids.js';
import { isDetermined, isNonDeterminato } from '../../../kernel/non-determinato.js';
import type { TenantScope } from '../../../kernel/scope.js';
import { AuditTrail, InMemoryAuditLogRepository } from '../../audit/index.js';
import { InMemoryTransactionRunner } from '../../tenancy/index.js';
import {
  InMemoryEntityAliasRepository,
  InMemoryEntityRepository,
  InMemoryEntityStore,
} from '../adapters/memory/in-memory-entity-repositories.js';
import { resolutionToDetermination } from '../domain/resolution.js';
import { EntityResolver } from './entity-resolver.js';
import { ImportEntities } from './import-entities.js';

const tenantId = newOrganizationId();
const scope: TenantScope = { kind: 'tenant', tenantId };
const actor = { type: ActorType.USER, id: 'admin' };

async function setup() {
  const clock = new FixedClock(new Date('2026-09-03T09:00:00.000Z'));
  const store = new InMemoryEntityStore(clock);
  const entities = new InMemoryEntityRepository(store);
  const aliases = new InMemoryEntityAliasRepository(store);
  const auditRepository = new InMemoryAuditLogRepository();
  const importer = new ImportEntities({
    transactions: new InMemoryTransactionRunner(),
    entities,
    aliases,
    audit: new AuditTrail({ repository: auditRepository, clock, context: noExecutionContext }),
  });
  const imported = await importer.execute(tenantId, actor, {
    source: 'erp-export.csv',
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
        email: 'ufficio.acquisti@rossi-impianti.it',
      },
      {
        kind: 'customer',
        name: 'Bianchi & Figli S.n.c.',
        code: 'C0100',
        email: 'mario.bianchi@gmail.com',
      },
      {
        kind: 'supplier',
        name: 'Acciaierie Venete S.p.A.',
        code: 'F0001',
        domain: 'acciaierievenete.com',
      },
    ],
  });
  if (!imported.ok) throw imported.error;
  return {
    store,
    entities,
    aliases,
    auditRepository,
    importer,
    imported: imported.value,
    resolver: new EntityResolver({ entities, aliases }),
  };
}

describe('ImportEntities', () => {
  it('creates entities with aliases, skips public mailbox domains, and audits the import', async () => {
    const { imported, store, auditRepository } = await setup();
    expect(imported).toMatchObject({ created: 4, updated: 0 });
    expect(imported.aliasesAdded).toBe(15);
    const kinds = store.aliases.map((a) => `${a.kind}:${a.value}`).sort();
    expect(kinds).toContain('email_domain:officine-rossi.it');
    expect(kinds).not.toContain('email_domain:gmail.com');
    expect(kinds).toContain('vat:IT01234567890');
    expect(kinds).toContain('name:acciaierie venete');
    expect(auditRepository.entries[0]).toMatchObject({
      action: 'entities.imported',
      details: { source: 'erp-export.csv', rows: 4, created: 4 },
    });
  });

  it('is idempotent and updates by code on re-import', async () => {
    const { importer, store } = await setup();
    const again = await importer.execute(tenantId, actor, {
      source: 'erp-export.csv',
      rows: [
        {
          kind: 'customer',
          name: 'Officine Meccaniche Rossi SRL',
          code: 'C0042',
          attributes: { paymentTerms: '60gg' },
        },
      ],
    });
    expect(again.ok && again.value).toMatchObject({ created: 0, updated: 1 });
    expect(store.entities.size).toBe(4);
    const rossi = [...store.entities.values()].find((e) => e.code === 'C0042');
    expect(rossi?.attributes).toEqual({ paymentTerms: '60gg' });
    expect(rossi?.name).toBe('Officine Meccaniche Rossi SRL');
  });
});

describe('EntityResolver', () => {
  it('resolves an exact e-mail alias with FACT-grade evidence', async () => {
    const { resolver } = await setup();
    const resolution = await resolver.resolve(scope, {
      kind: 'customer',
      email: 'Acquisti@Officine-Rossi.it',
      name: 'Rossi',
    });
    expect(resolution.kind).toBe('RESOLVED');
    if (resolution.kind !== 'RESOLVED') return;
    expect(resolution.match.entity.code).toBe('C0042');
    expect(resolution.match.reasons.map((r) => r.kind === 'alias' && r.aliasKind)).toEqual(
      expect.arrayContaining(['email', 'email_domain']),
    );
    const determination = resolutionToDetermination(resolution, 'sender of message 1');
    expect(isDetermined(determination)).toBe(true);
  });

  it('resolves through the company domain of an unknown address, but never through a public domain', async () => {
    const { resolver } = await setup();
    const viaDomain = await resolver.resolve(scope, {
      kind: 'customer',
      email: 'paolo.verdi@officine-rossi.it',
    });
    expect(viaDomain.kind).toBe('RESOLVED');
    if (viaDomain.kind === 'RESOLVED') expect(viaDomain.match.entity.code).toBe('C0042');

    const viaGmail = await resolver.resolve(scope, {
      kind: 'customer',
      email: 'someone.else@gmail.com',
    });
    expect(viaGmail.kind).toBe('UNRESOLVED');
  });

  it('reports ambiguity as NON_DETERMINATO with the candidates instead of guessing', async () => {
    const { resolver } = await setup();
    const resolution = await resolver.resolve(scope, { kind: 'customer', name: 'Rossi' });
    expect(resolution.kind).toBe('AMBIGUOUS');
    if (resolution.kind !== 'AMBIGUOUS') return;
    expect(resolution.candidates.length).toBeGreaterThanOrEqual(2);
    const determination = resolutionToDetermination(resolution, 'sender of message 2');
    expect(isNonDeterminato(determination)).toBe(true);
    if (!isNonDeterminato(determination)) return;
    expect(determination.known.length).toBe(resolution.candidates.length);
    expect(determination.missingInputs[0]).toMatchObject({
      name: 'counterpart identity',
      resolvableBy: 'HUMAN',
    });
    expect(determination.known.every((claim) => claim.status === 'ASSUMPTION')).toBe(true);
  });

  it('never resolves across entity kinds and keeps unresolved honest', async () => {
    const { resolver } = await setup();
    const supplierAsCustomer = await resolver.resolve(scope, {
      kind: 'customer',
      email: 'x@acciaierievenete.com',
    });
    expect(supplierAsCustomer.kind).toBe('UNRESOLVED');
    const supplier = await resolver.resolve(scope, {
      kind: 'supplier',
      email: 'x@acciaierievenete.com',
    });
    expect(supplier.kind).toBe('RESOLVED');
    const nobody = await resolver.resolve(scope, { kind: 'customer', name: 'Zeta Elettronica' });
    expect(nobody.kind).toBe('UNRESOLVED');
    const determination = resolutionToDetermination(nobody, 'sender');
    expect(isNonDeterminato(determination) && determination.unknown[0]).toContain(
      'No known record',
    );
  });
});
