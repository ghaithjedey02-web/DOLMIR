import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Migrator, loadMigrationFiles, noopLogger } from '@dolmir/core';

import {
  MIGRATIONS_DIR,
  createTestDatabase,
  type TestDatabase,
} from '../support/postgres-harness.js';

describe('migrator', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('applied every repository migration exactly once and reports a clean status', async () => {
    const migrator = new Migrator({
      ownerConnectionString: db.ownerUrl,
      directory: MIGRATIONS_DIR,
      logger: noopLogger,
    });
    const files = await loadMigrationFiles(MIGRATIONS_DIR);
    const status = await migrator.status();
    expect(status.pending).toEqual([]);
    expect(status.checksumMismatches).toEqual([]);
    expect(status.applied.map((m) => m.version)).toEqual(files.map((f) => f.version));
    expect(await migrator.migrate()).toEqual([]);
  });

  it('applies new migrations in version order and refuses edited ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dolmir-migrations-'));
    await writeFile(
      join(dir, '20990101000200_second.sql'),
      'CREATE TABLE public.mig_second (id int);',
    );
    await writeFile(
      join(dir, '20990101000100_first.sql'),
      'CREATE TABLE public.mig_first (id int);',
    );
    const migrator = new Migrator({
      ownerConnectionString: db.ownerUrl,
      directory: dir,
      logger: noopLogger,
    });

    expect(await migrator.migrate()).toEqual(['20990101000100', '20990101000200']);
    const tables = await db.ownerPool.query(
      "SELECT tablename FROM pg_tables WHERE tablename LIKE 'mig_%' ORDER BY tablename",
    );
    expect(tables.rows).toEqual([{ tablename: 'mig_first' }, { tablename: 'mig_second' }]);

    await writeFile(
      join(dir, '20990101000100_first.sql'),
      'CREATE TABLE public.mig_first (id bigint);',
    );
    await expect(migrator.migrate()).rejects.toMatchObject({ code: 'MIGRATION_CHECKSUM_MISMATCH' });
  });

  it('rolls back a failing migration without recording it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dolmir-migrations-'));
    await writeFile(
      join(dir, '20990102000100_broken.sql'),
      'CREATE TABLE public.mig_broken (id int); SELECT 1/0;',
    );
    const migrator = new Migrator({
      ownerConnectionString: db.ownerUrl,
      directory: dir,
      logger: noopLogger,
    });
    await expect(migrator.migrate()).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
    const tables = await db.ownerPool.query(
      "SELECT 1 FROM pg_tables WHERE tablename = 'mig_broken'",
    );
    expect(tables.rowCount).toBe(0);
    const recorded = await db.ownerPool.query(
      "SELECT 1 FROM public.schema_migrations WHERE version = '20990102000100'",
    );
    expect(recorded.rowCount).toBe(0);
  });

  it('rejects misnamed files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dolmir-migrations-'));
    await writeFile(join(dir, 'oops.sql'), 'SELECT 1;');
    await expect(loadMigrationFiles(dir)).rejects.toMatchObject({
      code: 'MIGRATION_FILENAME_INVALID',
    });
  });
});
