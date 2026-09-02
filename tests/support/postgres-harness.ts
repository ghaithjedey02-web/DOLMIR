import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import pg from 'pg';

import { Migrator, noopLogger } from '@dolmir/core';

const { Client, Pool } = pg;

/**
 * A fresh database per test run, migrated with the real migrator, reachable
 * as the three roles the platform distinguishes:
 *
 *   admin  — the server superuser (creates roles and databases; never used by DOLMIR)
 *   owner  — `dolmir_owner`, owns objects and runs migrations
 *   app    — `dolmir_app`, the runtime role that cannot bypass RLS
 *
 * The admin URL comes from DOLMIR_TEST_DATABASE_ADMIN_URL (CI service container
 * or local cluster). Passwords below are for throwaway test databases only.
 */
export interface TestDatabase {
  readonly name: string;
  readonly ownerUrl: string;
  readonly appUrl: string;
  readonly ownerPool: pg.Pool;
  readonly appPool: pg.Pool;
  drop(): Promise<void>;
}

const OWNER_PASSWORD = 'dolmir_owner_test';
const APP_PASSWORD = 'dolmir_app_test';

export const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../supabase/migrations',
);

export function adminUrl(): string {
  return (
    process.env['DOLMIR_TEST_DATABASE_ADMIN_URL'] ??
    'postgres://postgres:postgres@127.0.0.1:5432/postgres'
  );
}

function withDatabase(url: string, database: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `dolmir_test_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl(), application_name: 'dolmir-test-admin' });
  await admin.connect();
  try {
    await ensureRole(admin, 'dolmir_owner', OWNER_PASSWORD);
    await ensureRole(admin, 'dolmir_app', APP_PASSWORD);
    await admin.query(`CREATE DATABASE ${name} OWNER dolmir_owner`);
  } finally {
    await admin.end();
  }

  const ownerUrl = withDatabase(adminUrl(), name, 'dolmir_owner', OWNER_PASSWORD);
  const appUrl = withDatabase(adminUrl(), name, 'dolmir_app', APP_PASSWORD);

  const migrator = new Migrator({
    ownerConnectionString: ownerUrl,
    directory: MIGRATIONS_DIR,
    logger: noopLogger,
  });
  await migrator.migrate();

  const ownerPool = new Pool({ connectionString: ownerUrl, max: 4 });
  const appPool = new Pool({ connectionString: appUrl, max: 8 });

  return {
    name,
    ownerUrl,
    appUrl,
    ownerPool,
    appPool,
    async drop() {
      await appPool.end();
      await ownerPool.end();
      const client = new Client({ connectionString: adminUrl() });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}

async function ensureRole(admin: pg.Client, role: string, password: string): Promise<void> {
  const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (exists.rowCount === 0) {
    // Role names are constants from this file, never user input.
    await admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS`,
    );
  }
}
