import { type JWTPayload, type JWTVerifyGetKey, createRemoteJWKSet, errors, jwtVerify } from 'jose';

import type { Clock } from '../../../../kernel/clock.js';
import { UnauthenticatedError } from '../../../../kernel/errors.js';
import { err, ok, type Result } from '../../../../kernel/result.js';
import type { AuthConfig } from '../../../../infrastructure/config/schema.js';
import type { TokenVerifier } from '../../application/ports.js';
import { type UserPrincipal, UserPrincipalSchema } from '../../domain/principal.js';

/**
 * JWT verification with `jose`.
 *
 * Two key sources, one at a time (validated in configuration): a JWKS
 * endpoint for asymmetric tokens (Supabase Auth publishes one) or a shared
 * HS256 secret (legacy Supabase projects, local development). Algorithms are
 * pinned per key source so a token cannot pick its own. Time comes from the
 * injected `Clock` so expiry is testable.
 */
export type KeySource =
  | { readonly kind: 'hs256'; readonly secret: Uint8Array }
  | { readonly kind: 'jwks'; readonly getKey: JWTVerifyGetKey };

export interface JwtVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly key: KeySource;
  readonly clock: Clock;
  /** Seconds of leeway for `exp`/`nbf`, to absorb clock skew between services. */
  readonly clockToleranceSeconds?: number;
}

const ASYMMETRIC_ALGORITHMS = ['RS256', 'ES256'];

export class JwtVerifier implements TokenVerifier {
  private readonly options: JwtVerifierOptions;

  constructor(options: JwtVerifierOptions) {
    this.options = options;
  }

  async verify(token: string): Promise<Result<UserPrincipal, UnauthenticatedError>> {
    if (token.trim().length === 0) {
      return err(new UnauthenticatedError('MISSING_TOKEN', 'A bearer token is required.'));
    }
    const { issuer, audience, key, clock } = this.options;
    const verifyOptions = {
      issuer,
      audience,
      currentDate: clock.now(),
      clockTolerance: this.options.clockToleranceSeconds ?? 30,
      algorithms: key.kind === 'hs256' ? ['HS256'] : ASYMMETRIC_ALGORITHMS,
    };
    try {
      const { payload } =
        key.kind === 'hs256'
          ? await jwtVerify(token, key.secret, verifyOptions)
          : await jwtVerify(token, key.getKey, verifyOptions);
      return toPrincipal(payload);
    } catch (error) {
      return err(translateJoseError(error));
    }
  }
}

function toPrincipal(payload: JWTPayload): Result<UserPrincipal, UnauthenticatedError> {
  const email = typeof payload['email'] === 'string' ? payload['email'].toLowerCase() : undefined;
  const nameClaim = payload['name'] ?? payload['full_name'];
  const displayName = typeof nameClaim === 'string' ? nameClaim : undefined;
  const candidate = {
    kind: 'user' as const,
    subject: payload.sub,
    issuer: payload.iss,
    ...(email === undefined ? {} : { email }),
    ...(displayName === undefined ? {} : { displayName }),
    expiresAt: payload.exp === undefined ? undefined : new Date(payload.exp * 1000),
  };
  const parsed = UserPrincipalSchema.safeParse(candidate);
  if (!parsed.success) {
    return err(
      new UnauthenticatedError('INVALID_TOKEN', 'The token is missing required claims.', {
        details: {
          reason: 'CLAIMS_INVALID',
          issues: parsed.error.issues.map((i) => i.path.join('.')),
        },
      }),
    );
  }
  return ok(parsed.data);
}

function translateJoseError(error: unknown): UnauthenticatedError {
  if (error instanceof errors.JWTExpired) {
    return new UnauthenticatedError('TOKEN_EXPIRED', 'The token has expired.', {
      details: { reason: error.code },
    });
  }
  if (error instanceof errors.JOSEError) {
    return new UnauthenticatedError('INVALID_TOKEN', 'The token could not be verified.', {
      details: { reason: error.code },
    });
  }
  return new UnauthenticatedError('INVALID_TOKEN', 'The token could not be verified.', {
    details: { reason: 'UNKNOWN' },
    cause: error,
  });
}

/** Builds the verifier from validated configuration (exactly one key source is set). */
export function jwtVerifierFromConfig(auth: AuthConfig, clock: Clock): JwtVerifier {
  const key: KeySource =
    auth.hs256Secret !== undefined
      ? { kind: 'hs256', secret: new TextEncoder().encode(auth.hs256Secret.reveal()) }
      : { kind: 'jwks', getKey: createRemoteJWKSet(new URL(auth.jwksUrl ?? '')) };
  return new JwtVerifier({ issuer: auth.issuer, audience: auth.audience, key, clock });
}
