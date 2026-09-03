import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import pg from 'pg';
import { z } from 'zod';

import { InfrastructureError, PreconditionFailedError } from '../../kernel/errors.js';
import type { Logger } from '../../kernel/logger.js';
import { translatePgError } from './errors.js';

const { Client } = pg;

/**
 * Forward-only SQL migrations from `supabase/migrations/<version>_<name>.sql`
 * (Supabase CLI layout, own runner). Each file runs once, in a transaction
 * unless it opts out with `-- dolmir:no-transaction`; its checksum is recorded
 * so editing an applied migration is detected instead of silently ignored.
 * A session advisory lock serialises concurrent migrators.
 */

const FILE_PATTERN = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const NO_TRANSACTION_MARKER = '-- dolmir:no-transaction';
const ADVISORY_LOCK_KEY = 7_412_930_001; // arbitrary constant, unique to DOLMIR

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly path: string;
  readonly sql: string;
  readonly checksum: string;
  readonly transactional: boolean;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export interface MigrationStatus {
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly MigrationFile[];
  readonly checksumMismatches: readonly { version: string; expected: string; actual: string }[];
}

/** Anything that can run a text query: a `pg.Pool` or a `pg.Client`. */
export interface MigrationQueryable {
  query(text: string): Promise<{ rows: unknown[] }>;
}

/**
 * Compares the migration files on disk with `schema_migrations` using any
 * connection — the runtime role may read the ledger — so readiness checks and
 * `doctor` can report pending migrations without owner credentials.
 */
export async function readMigrationStatus(
  queryable: MigrationQueryable,
  directory: string,
): Promise<MigrationStatus> {
  const files = await loadMigrationFiles(directory);
  try {
    return await computeStatus(queryable, files);
  } catch (error) {
    throw translatePgError(error);
  }
}

export async function loadMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory);
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry);
    if (match === null) {
      if (entry.endsWith('.sql')) {
        throw new PreconditionFailedError(
          'MIGRATION_FILENAME_INVALID',
          `Migration file "${entry}" must be named <14-digit-version>_<snake_case_name>.sql.`,
        );
      }
      continue;
    }
    const [, version, name] = match;
    if (version === undefined || name === undefined) continue;
    const path = join(directory, entry);
    const sql = await readFile(path, 'utf8');
    files.push({
      version,
      name,
      path,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      transactional: !sql.includes(NO_TRANSACTION_MARKER),
    });
  }
  files.sort((a, b) => a.version.localeCompare(b.version));
  const versions = new Set<string>();
  for (const file of files) {
    if (versions.has(file.version)) {
      throw new PreconditionFailedError(
        'MIGRATION_VERSION_DUPLICATE',
        `Two migration files share version ${file.version}.`,
      );
    }
    versions.add(file.version);
  }
  return files;
}

export interface MigratorOptions {
  /** Connection string of the object-owning role (never the runtime role). */
  readonly ownerConnectionString: string;
  readonly directory: string;
  readonly logger: Logger;
}

export class Migrator {
  private readonly options: MigratorOptions;

  constructor(options: MigratorOptions) {
    this.options = options;
  }

  async status(): Promise<MigrationStatus> {
    const files = await loadMigrationFiles(this.options.directory);
    return this.withClient(async (client) => {
      await ensureLedgerTable(client);
      return computeStatus(client, files);
    });
  }

  /** Applies every pending migration in order. Returns the versions applied. */
  async migrate(): Promise<string[]> {
    const files = await loadMigrationFiles(this.options.directory);
    return this.withClient(async (client) => {
      await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
      try {
        await ensureLedgerTable(client);
        const status = await computeStatus(client, files);
        if (status.checksumMismatches.length > 0) {
          const list = status.checksumMismatches.map((m) => m.version).join(', ');
          throw new PreconditionFailedError(
            'MIGRATION_CHECKSUM_MISMATCH',
            `Applied migration(s) ${list} were modified after being applied. Never edit an applied migration; add a new one.`,
            { details: { mismatches: status.checksumMismatches } },
          );
        }
        const applied: string[] = [];
        for (const file of status.pending) {
          await applyOne(client, file);
          this.options.logger.info('migration applied', { version: file.version, name: file.name });
          applied.push(file.version);
        }
        return applied;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
      }
    });
  }

  private async withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new Client({
      connectionString: this.options.ownerConnectionString,
      application_name: 'dolmir-migrator',
    });
    try {
      await client.connect();
    } catch (error) {
      throw translatePgError(error);
    }
    try {
      return await fn(client);
    } catch (error) {
      throw translatePgError(error);
    } finally {
      await client.end();
    }
  }
}

async function ensureLedgerTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      applied_by text NOT NULL DEFAULT current_user
    )
  `);
}

const AppliedRowSchema = z.object({
  version: z.string(),
  name: z.string(),
  checksum: z.string(),
  applied_at: z.date(),
});

async function computeStatus(
  queryable: MigrationQueryable,
  files: MigrationFile[],
): Promise<MigrationStatus> {
  const result = await queryable.query(
    'SELECT version, name, checksum, applied_at FROM public.schema_migrations ORDER BY version',
  );
  const applied = result.rows.map((raw) => {
    const row = AppliedRowSchema.parse(raw);
    return {
      version: row.version,
      name: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at,
    };
  });
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  const pending = files.filter((file) => !appliedByVersion.has(file.version));
  const checksumMismatches = files.flatMap((file) => {
    const existing = appliedByVersion.get(file.version);
    return existing !== undefined && existing.checksum !== file.checksum
      ? [{ version: file.version, expected: existing.checksum, actual: file.checksum }]
      : [];
  });
  return { applied, pending, checksumMismatches };
}

async function applyOne(client: pg.Client, file: MigrationFile): Promise<void> {
  const record = () =>
    client.query(
      'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      [file.version, file.name, file.checksum],
    );
  if (file.transactional) {
    await client.query('BEGIN');
    try {
      await client.query(file.sql);
      await record();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new InfrastructureError(
        'MIGRATION_FAILED',
        `Migration ${file.version}_${file.name} failed and was rolled back.`,
        { cause: error, details: { version: file.version } },
      );
    }
  } else {
    await client.query(file.sql);
    await record();
  }
}
