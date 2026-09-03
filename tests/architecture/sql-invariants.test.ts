import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

/**
 * Architecture invariants enforced against the migrated schema (plan §H, §L):
 * a new table cannot slip in without Row-Level Security, and append-only
 * tables cannot be mutated by the runtime role. A violation fails CI.
 */

/** Tables that are deliberately not tenant-scoped. Adding one here is a reviewed decision. */
const NOT_TENANT_SCOPED = new Set(['schema_migrations', 'projection_checkpoints']);

/** Tables whose rows are immutable by design (ADR-0004). Extended as modules arrive. */
const APPEND_ONLY = ['audit_log', 'ledger_events', 'ai_usage', 'company_rules'];

/**
 * Read-model tables derived from immutable ledger events (ADR-0012 §3): the
 * runtime role may only insert into them; the owner clears them on a rebuild.
 */
const RUNTIME_INSERT_ONLY = ['case_findings', 'approvals', 'actions'];

describe('SQL invariants', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('every table in public is RLS-enabled and forced with at least one policy, unless allow-listed', async () => {
    const tables = await db.ownerPool.query<{
      tablename: string;
      rowsecurity: boolean;
      forcerowsecurity: boolean;
      policies: number;
    }>(`
      SELECT c.relname AS tablename,
             c.relrowsecurity AS rowsecurity,
             c.relforcerowsecurity AS forcerowsecurity,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
       ORDER BY c.relname
    `);
    expect(tables.rowCount).toBeGreaterThan(0);
    const violations = tables.rows
      .filter((t) => !NOT_TENANT_SCOPED.has(t.tablename))
      .filter((t) => !t.rowsecurity || !t.forcerowsecurity || t.policies === 0)
      .map((t) => t.tablename);
    expect(violations).toEqual([]);
  });

  it('the runtime role holds no DELETE grant on any table and no UPDATE grant on append-only tables', async () => {
    const grants = await db.ownerPool.query<{ table_name: string; privilege_type: string }>(`
      SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
       WHERE grantee = 'dolmir_app' AND table_schema = 'public'
    `);
    const deletes = grants.rows
      .filter((g) => g.privilege_type === 'DELETE')
      .map((g) => g.table_name);
    expect(deletes).toEqual([]);
    const appendOnlyUpdates = grants.rows
      .filter((g) => g.privilege_type === 'UPDATE' && APPEND_ONLY.includes(g.table_name))
      .map((g) => g.table_name);
    expect(appendOnlyUpdates).toEqual([]);
    const insertOnlyUpdates = grants.rows
      .filter((g) => g.privilege_type === 'UPDATE' && RUNTIME_INSERT_ONLY.includes(g.table_name))
      .map((g) => g.table_name);
    expect(insertOnlyUpdates).toEqual([]);
  });

  it('append-only tables that exist carry the forbid_mutation trigger', async () => {
    const existing = await db.ownerPool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [APPEND_ONLY],
    );
    for (const { tablename } of existing.rows) {
      const trigger = await db.ownerPool.query(
        `SELECT 1
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE c.relname = $1 AND p.proname = 'forbid_mutation' AND NOT t.tgisinternal`,
        [tablename],
      );
      expect(trigger.rowCount, `${tablename} lacks the append-only trigger`).toBe(1);
    }
  });

  it('the runtime role cannot bypass RLS', async () => {
    const role = await db.ownerPool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'dolmir_app'",
    );
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});
