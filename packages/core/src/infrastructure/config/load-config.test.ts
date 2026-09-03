import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { KNOWN_VARIABLES, loadConfig } from './index.js';

const minimal = {
  DOLMIR_DATABASE_URL: 'postgres://dolmir_app:pw@localhost:5432/dolmir',
  DOLMIR_AUTH_ISSUER: 'http://localhost:3000/dev-auth',
  DOLMIR_AUTH_AUDIENCE: 'dolmir',
  DOLMIR_AUTH_HS256_SECRET: 'dev-only-secret-change-me-please-32chars',
};

describe('loadConfig', () => {
  it('applies development defaults to a minimal environment', () => {
    const result = loadConfig(minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.env).toBe('development');
    expect(result.value.log).toEqual({ level: 'debug', format: 'pretty' });
    expect(result.value.http).toEqual({ host: '127.0.0.1', port: 3000 });
    expect(result.value.database.poolMax).toBe(10);
    expect(result.value.storage).toEqual({ driver: 'memory' });
    expect(result.value.ai.provider).toBe('none');
    expect(result.value.ai.anthropic).toBeUndefined();
  });

  it('switches to json logs at info level outside development', () => {
    const result = loadConfig({
      ...minimal,
      DOLMIR_ENV: 'production',
      // Production also demands a secrets key and a durable job queue (ADR-0013, ADR-0014).
      DOLMIR_SECRETS_KEY: Buffer.alloc(32, 3).toString('base64'),
      DOLMIR_JOBS_DRIVER: 'pg-boss',
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.log).toEqual({ level: 'info', format: 'json' });
  });

  it('coerces numbers and ignores empty strings', () => {
    const result = loadConfig({ ...minimal, DOLMIR_HTTP_PORT: '8080', DOLMIR_LOG_LEVEL: '' });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.http.port).toBe(8080);
    expect(result.value.log.level).toBe('debug');
  });

  it('rejects unknown DOLMIR_* variables and lists the recognised ones', () => {
    const result = loadConfig({
      ...minimal,
      DOLMIR_LOG_LEVL: 'debug',
      DOLMIR_TEST_DATABASE_ADMIN_URL: 'x',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_CONFIGURATION');
    expect(result.error.message).toContain('DOLMIR_LOG_LEVL');
    expect(result.error.message).not.toContain('DOLMIR_TEST_DATABASE_ADMIN_URL');
    expect(result.error.details['unknown']).toEqual(['DOLMIR_LOG_LEVL']);
    expect(result.error.message).toContain('DOLMIR_LOG_LEVEL');
    expect(KNOWN_VARIABLES).toContain('DOLMIR_DATABASE_URL');
  });

  it('reports every invalid value with the variable name', () => {
    const result = loadConfig({
      ...minimal,
      DOLMIR_HTTP_PORT: 'eighty',
      DOLMIR_DATABASE_URL: 'mysql://nope',
      DOLMIR_ENV: 'staging',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const problems = result.error.details['problems'] as { variable: string }[];
    expect(problems.map((p) => p.variable).sort()).toEqual([
      'DOLMIR_DATABASE_URL',
      'DOLMIR_ENV',
      'DOLMIR_HTTP_PORT',
    ]);
    expect(result.error.message).toContain('3 problem(s)');
  });

  it('enforces cross-field rules: one auth mechanism, key for anthropic, root for local storage', () => {
    const both = loadConfig({
      ...minimal,
      DOLMIR_AUTH_JWKS_URL: 'https://x.supabase.co/auth/v1/.well-known/jwks.json',
    });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error.message).toContain('exactly one of');

    const { DOLMIR_AUTH_HS256_SECRET: _omit, ...withoutAuth } = minimal;
    const none = loadConfig(withoutAuth);
    expect(none.ok).toBe(false);

    const anthropic = loadConfig({ ...minimal, DOLMIR_AI_PROVIDER: 'anthropic' });
    expect(anthropic.ok).toBe(false);
    if (!anthropic.ok) expect(anthropic.error.message).toContain('DOLMIR_AI_ANTHROPIC_API_KEY');

    const local = loadConfig({ ...minimal, DOLMIR_STORAGE_DRIVER: 'local' });
    expect(local.ok).toBe(false);
    if (!local.ok) expect(local.error.message).toContain('DOLMIR_STORAGE_LOCAL_ROOT');

    const localOk = loadConfig({
      ...minimal,
      DOLMIR_STORAGE_DRIVER: 'local',
      DOLMIR_STORAGE_LOCAL_ROOT: '/tmp/x',
    });
    expect(localOk.ok).toBe(true);
    if (localOk.ok) expect(localOk.value.storage).toEqual({ driver: 'local', localRoot: '/tmp/x' });
  });

  it('wraps secrets so they never print, serialise or inspect as plain text', () => {
    const result = loadConfig({
      ...minimal,
      DOLMIR_AI_PROVIDER: 'anthropic',
      DOLMIR_AI_ANTHROPIC_API_KEY: 'sk-ant-very-secret',
    });
    if (!result.ok) throw new Error(result.error.message);
    const config = result.value;
    const rendered = [
      JSON.stringify(config),
      inspect(config, { depth: 10 }),
      String(config.database.url),
      String(config.ai.anthropic?.apiKey),
    ].join('\n');
    expect(rendered).not.toContain('sk-ant-very-secret');
    expect(rendered).not.toContain('pw@localhost');
    expect(rendered).not.toContain('change-me-please');
    expect(config.ai.anthropic?.apiKey.reveal()).toBe('sk-ant-very-secret');
    expect(config.auth.hs256Secret?.length).toBe(minimal.DOLMIR_AUTH_HS256_SECRET.length);
  });

  it('accepts a base64 secrets key, rejects a short one, and requires it with pg-boss in production', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const ok = loadConfig({ ...minimal, DOLMIR_SECRETS_KEY: key, DOLMIR_JOBS_DRIVER: 'pg-boss' });
    if (!ok.ok) throw new Error(ok.error.message);
    expect(ok.value.secrets.key?.reveal()).toBe(key);
    expect(ok.value.jobs).toEqual({ driver: 'pg-boss', schema: 'dolmir_jobs' });
    expect(String(ok.value.secrets.key)).toBe('[secret]');

    const short = loadConfig({ ...minimal, DOLMIR_SECRETS_KEY: 'dG9vLXNob3J0' });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error.message).toContain('DOLMIR_SECRETS_KEY');

    const production = loadConfig({ ...minimal, DOLMIR_ENV: 'production' });
    expect(production.ok).toBe(false);
    if (!production.ok) {
      const problems = production.error.details['problems'] as { variable: string }[];
      expect(problems.map((p) => p.variable).sort()).toEqual([
        'DOLMIR_JOBS_DRIVER',
        'DOLMIR_SECRETS_KEY',
      ]);
    }
    const defaults = loadConfig(minimal);
    if (!defaults.ok) throw new Error(defaults.error.message);
    expect(defaults.value.secrets.key).toBeUndefined();
    expect(defaults.value.jobs.driver).toBe('memory');
  });

  it('returns a frozen configuration object', () => {
    const result = loadConfig(minimal);
    if (!result.ok) throw new Error(result.error.message);
    expect(Object.isFrozen(result.value)).toBe(true);
  });
});
