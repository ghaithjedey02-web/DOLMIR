import { DomainError, ErrorCategory } from '../../kernel/errors.js';
import { err, ok, type Result } from '../../kernel/result.js';
import { type Config, type Env, EnvSchema, KNOWN_VARIABLES, type StorageConfig } from './schema.js';
import { Secret } from './secret.js';

/**
 * Fail-fast configuration loading.
 *
 * The loader receives a plain record (the composition root passes
 * `process.env`; tests pass literals) and returns either a fully validated,
 * immutable `Config` or one error listing every problem. Secrets are wrapped
 * before they leave this module.
 */

export const CONFIG_PREFIX = 'DOLMIR_';

/** Variables in this namespace belong to the test harness and are ignored here. */
export const IGNORED_PREFIXES: readonly string[] = ['DOLMIR_TEST_'];

export class ConfigurationError extends DomainError {
  constructor(message: string, details: Readonly<Record<string, unknown>>) {
    super(ErrorCategory.INTERNAL, 'INVALID_CONFIGURATION', message, { details });
  }
}

export type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: EnvironmentRecord): Result<Config, ConfigurationError> {
  const unknown = Object.keys(env)
    .filter(
      (key) =>
        key.startsWith(CONFIG_PREFIX) &&
        !IGNORED_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
        !KNOWN_VARIABLES.includes(key),
    )
    .sort();
  if (unknown.length > 0) {
    return err(
      new ConfigurationError(
        [
          `Invalid DOLMIR configuration: unknown environment variable(s): ${unknown.join(', ')}.`,
          `Recognised variables: ${KNOWN_VARIABLES.join(', ')}.`,
        ].join('\n'),
        { unknown, recognised: KNOWN_VARIABLES },
      ),
    );
  }

  // Empty strings (common in .env files) mean "not set".
  const candidate: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(CONFIG_PREFIX) && value !== undefined && value !== '') {
      candidate[key] = value;
    }
  }

  const parsed = EnvSchema.safeParse(candidate);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => ({
      variable: issue.path.map(String).join('.') || '(configuration)',
      message: issue.message,
    }));
    const listing = problems.map((p) => `  - ${p.variable}: ${p.message}`).join('\n');
    return err(
      new ConfigurationError(
        `Invalid DOLMIR configuration (${problems.length} problem(s)):\n${listing}`,
        { problems },
      ),
    );
  }

  return ok(toConfig(parsed.data));
}

function toConfig(env: Env): Config {
  const storage: StorageConfig =
    env.DOLMIR_STORAGE_DRIVER === 'local'
      ? // The refinement guarantees the root is present for the local driver.
        { driver: 'local', localRoot: env.DOLMIR_STORAGE_LOCAL_ROOT ?? '.dolmir/storage' }
      : { driver: 'memory' };

  return Object.freeze({
    env: env.DOLMIR_ENV,
    log: {
      level: env.DOLMIR_LOG_LEVEL ?? (env.DOLMIR_ENV === 'development' ? 'debug' : 'info'),
      format: env.DOLMIR_LOG_FORMAT ?? (env.DOLMIR_ENV === 'development' ? 'pretty' : 'json'),
    },
    http: { host: env.DOLMIR_HTTP_HOST, port: env.DOLMIR_HTTP_PORT },
    database: {
      url: new Secret(env.DOLMIR_DATABASE_URL),
      ownerUrl:
        env.DOLMIR_DATABASE_OWNER_URL === undefined
          ? undefined
          : new Secret(env.DOLMIR_DATABASE_OWNER_URL),
      poolMax: env.DOLMIR_DATABASE_POOL_MAX,
    },
    auth: {
      issuer: env.DOLMIR_AUTH_ISSUER,
      audience: env.DOLMIR_AUTH_AUDIENCE,
      jwksUrl: env.DOLMIR_AUTH_JWKS_URL,
      hs256Secret:
        env.DOLMIR_AUTH_HS256_SECRET === undefined
          ? undefined
          : new Secret(env.DOLMIR_AUTH_HS256_SECRET),
    },
    storage,
    ai: {
      provider: env.DOLMIR_AI_PROVIDER,
      anthropic:
        env.DOLMIR_AI_ANTHROPIC_API_KEY === undefined
          ? undefined
          : {
              apiKey: new Secret(env.DOLMIR_AI_ANTHROPIC_API_KEY),
              baseUrl: env.DOLMIR_AI_ANTHROPIC_BASE_URL,
            },
      models: {
        fast: env.DOLMIR_AI_MODEL_FAST,
        standard: env.DOLMIR_AI_MODEL_STANDARD,
        deep: env.DOLMIR_AI_MODEL_DEEP,
      },
    },
    secrets: {
      key: env.DOLMIR_SECRETS_KEY === undefined ? undefined : new Secret(env.DOLMIR_SECRETS_KEY),
    },
    jobs: { driver: env.DOLMIR_JOBS_DRIVER, schema: env.DOLMIR_JOBS_SCHEMA },
    mailbox: { driver: env.DOLMIR_MAILBOX_DRIVER },
  });
}
