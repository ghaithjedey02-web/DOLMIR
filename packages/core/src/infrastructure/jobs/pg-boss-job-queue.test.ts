import { describe, expect, it } from 'vitest';

import { isDomainError } from '../../kernel/errors.js';
import { PgBossJobQueue, runtimeRoleFromConnectionString } from './pg-boss-job-queue.js';

/**
 * The pieces of the pg-boss adapter that hold without a database. Everything
 * that needs one — installing the schema, granting the runtime role, working a
 * queue as that role — is proved against real PostgreSQL in
 * `tests/integration/job-runtime.test.ts`.
 */
describe('runtimeRoleFromConnectionString', () => {
  it('takes the role from the runtime connection URL', () => {
    expect(runtimeRoleFromConnectionString('postgres://dolmir_app:pw@db:5432/dolmir')).toBe(
      'dolmir_app',
    );
    expect(runtimeRoleFromConnectionString('postgresql://dolmir_app@db/dolmir')).toBe('dolmir_app');
  });

  it('decodes a percent-encoded user', () => {
    expect(runtimeRoleFromConnectionString('postgres://dolmir%5Fapp:pw@db/dolmir')).toBe(
      'dolmir_app',
    );
  });

  it('refuses a URL with no user rather than guessing one', () => {
    expect(() => runtimeRoleFromConnectionString('postgres://db:5432/dolmir')).toThrow(
      /carries no user/,
    );
  });

  it('refuses anything that is not a plain lowercase identifier', () => {
    // The role is interpolated into GRANT statements; only an identifier is safe.
    for (const url of [
      'postgres://Dolmir:pw@db/dolmir',
      'postgres://app%3Bdrop:pw@db/dolmir',
      'postgres://app%20name:pw@db/dolmir',
      'postgres://1app:pw@db/dolmir',
    ]) {
      expect(() => runtimeRoleFromConnectionString(url)).toThrow(/lowercase SQL identifier/);
    }
  });

  it('reports an unparseable URL as a configuration problem, not a crash', () => {
    try {
      runtimeRoleFromConnectionString('not a url');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isDomainError(error) && error.code).toBe('INVALID_JOBS_RUNTIME_ROLE');
    }
  });
});

describe('PgBossJobQueue', () => {
  it('refuses a schema name that is not an identifier before it connects to anything', () => {
    expect(
      () =>
        new PgBossJobQueue({
          connectionString: 'postgres://dolmir_app:pw@db/dolmir',
          schema: 'public; drop table users',
        }),
    ).toThrow(/lowercase SQL identifier/);
  });
});
