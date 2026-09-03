import { z } from 'zod';

import type { Secret } from './secret.js';

/**
 * Every environment variable the platform understands, with its validation.
 * This table is the single source of truth: the loader derives the list of
 * recognised names from it, so an unknown `DOLMIR_*` variable is a boot failure
 * rather than a silently ignored typo.
 */

const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), {
    message: 'must be a postgres:// or postgresql:// connection URL',
  });

function isBase64Of32Bytes(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  return Buffer.from(value, 'base64').byteLength === 32;
}

export const Environment = z.enum(['development', 'test', 'production']);
export type Environment = z.infer<typeof Environment>;

export const EnvSchema = z
  .object({
    DOLMIR_ENV: Environment.default('development'),
    DOLMIR_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    DOLMIR_LOG_FORMAT: z.enum(['json', 'pretty']).optional(),

    DOLMIR_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
    DOLMIR_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    /** Runtime connection — the restricted `dolmir_app` role (ADR-0005). */
    DOLMIR_DATABASE_URL: postgresUrl,
    /** Migrations — the object-owning role. Optional at runtime. */
    DOLMIR_DATABASE_OWNER_URL: postgresUrl.optional(),
    DOLMIR_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

    DOLMIR_AUTH_ISSUER: z.string().min(1),
    DOLMIR_AUTH_AUDIENCE: z.string().min(1),
    DOLMIR_AUTH_JWKS_URL: z.url().optional(),
    DOLMIR_AUTH_HS256_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),

    DOLMIR_STORAGE_DRIVER: z.enum(['memory', 'local']).default('memory'),
    DOLMIR_STORAGE_LOCAL_ROOT: z.string().min(1).optional(),

    DOLMIR_AI_PROVIDER: z.enum(['none', 'fake', 'anthropic']).default('none'),
    DOLMIR_AI_ANTHROPIC_API_KEY: z.string().min(1).optional(),
    DOLMIR_AI_ANTHROPIC_BASE_URL: z.url().optional(),
    DOLMIR_AI_MODEL_FAST: z.string().min(1).optional(),
    DOLMIR_AI_MODEL_STANDARD: z.string().min(1).optional(),
    DOLMIR_AI_MODEL_DEEP: z.string().min(1).optional(),

    /** 32 random bytes, base64: encrypts per-tenant connector credentials (ADR-0013). */
    DOLMIR_SECRETS_KEY: z
      .string()
      .refine((value) => isBase64Of32Bytes(value), {
        message: 'must be 32 random bytes encoded as base64 (44 characters)',
      })
      .optional(),

    /** Background jobs (ADR-0014): pg-boss in production, in-memory for development and tests. */
    DOLMIR_JOBS_DRIVER: z.enum(['memory', 'pg-boss']).default('memory'),
    DOLMIR_JOBS_SCHEMA: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/, 'must be a lowercase identifier')
      .default('dolmir_jobs'),

    /**
     * Mailbox provider (ADR-0013). `imap_smtp` talks to a real server; `fake`
     * keeps messages in memory so the whole chain can be exercised without a
     * mailbox, and is refused in production.
     */
    DOLMIR_MAILBOX_DRIVER: z.enum(['imap_smtp', 'fake']).default('imap_smtp'),
  })
  .superRefine((env, ctx) => {
    if (env.DOLMIR_ENV === 'production' && env.DOLMIR_SECRETS_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['DOLMIR_SECRETS_KEY'],
        message: 'required in production (connector credentials cannot be stored without it)',
      });
    }
    if (env.DOLMIR_ENV === 'production' && env.DOLMIR_MAILBOX_DRIVER === 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['DOLMIR_MAILBOX_DRIVER'],
        message: 'the in-memory mailbox is for development only and never sends a real message',
      });
    }
    if (env.DOLMIR_ENV === 'production' && env.DOLMIR_JOBS_DRIVER !== 'pg-boss') {
      ctx.addIssue({
        code: 'custom',
        path: ['DOLMIR_JOBS_DRIVER'],
        message: 'must be pg-boss in production (in-memory jobs are lost on restart)',
      });
    }
    const hasJwks = env.DOLMIR_AUTH_JWKS_URL !== undefined;
    const hasHs256 = env.DOLMIR_AUTH_HS256_SECRET !== undefined;
    if (hasJwks === hasHs256) {
      ctx.addIssue({
        code: 'custom',
        path: ['DOLMIR_AUTH_JWKS_URL'],
        message:
          'exactly one of DOLMIR_AUTH_JWKS_URL (asymmetric) or DOLMIR_AUTH_HS256_SECRET (symmetric) must be set',
      });
    }
    if (env.DOLMIR_AI_PROVIDER === 'anthropic' && env.DOLMIR_AI_ANTHROPIC_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['DOLMIR_AI_ANTHROPIC_API_KEY'],
        message: 'required when DOLMIR_AI_PROVIDER=anthropic',
      });
    }
    if (env.DOLMIR_STORAGE_DRIVER === 'local' && env.DOLMIR_STORAGE_LOCAL_ROOT === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['DOLMIR_STORAGE_LOCAL_ROOT'],
        message: 'required when DOLMIR_STORAGE_DRIVER=local',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/** The names the loader recognises. Anything else prefixed `DOLMIR_` is rejected. */
export const KNOWN_VARIABLES: readonly string[] = Object.keys(EnvSchema.def.shape).sort();

export type LogLevelSetting = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'pretty';

export interface DatabaseConfig {
  readonly url: Secret;
  readonly ownerUrl: Secret | undefined;
  readonly poolMax: number;
}

export interface AuthConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string | undefined;
  readonly hs256Secret: Secret | undefined;
}

export type StorageConfig =
  { readonly driver: 'memory' } | { readonly driver: 'local'; readonly localRoot: string };

export interface AiModelOverrides {
  readonly fast: string | undefined;
  readonly standard: string | undefined;
  readonly deep: string | undefined;
}

export interface AiConfig {
  readonly provider: 'none' | 'fake' | 'anthropic';
  readonly anthropic: { readonly apiKey: Secret; readonly baseUrl: string | undefined } | undefined;
  readonly models: AiModelOverrides;
}

export interface SecretsConfig {
  /** Absent only outside production: connector credentials cannot be stored without it. */
  readonly key: Secret | undefined;
}

export interface JobsConfig {
  readonly driver: 'memory' | 'pg-boss';
  readonly schema: string;
}

export interface MailboxConfig {
  readonly driver: 'imap_smtp' | 'fake';
}

export interface Config {
  readonly env: Environment;
  readonly log: { readonly level: LogLevelSetting; readonly format: LogFormat };
  readonly http: { readonly host: string; readonly port: number };
  readonly database: DatabaseConfig;
  readonly auth: AuthConfig;
  readonly storage: StorageConfig;
  readonly ai: AiConfig;
  readonly secrets: SecretsConfig;
  readonly jobs: JobsConfig;
  readonly mailbox: MailboxConfig;
}
