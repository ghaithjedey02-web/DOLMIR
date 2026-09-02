import { SignJWT } from 'jose';

import type { Clock } from '../../../../kernel/clock.js';

/**
 * Mints HS256 tokens for local development and tests, with the same issuer
 * and audience the verifier expects. Never wired in production: the
 * composition root only constructs it when the HS256 secret is configured and
 * the environment is not `production`.
 */
export interface DevTokenIssuerOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly secret: Uint8Array;
  readonly clock: Clock;
}

export interface DevTokenClaims {
  readonly subject: string;
  readonly email?: string;
  readonly displayName?: string;
  /** Lifetime in seconds (default one hour). */
  readonly ttlSeconds?: number;
}

export class DevTokenIssuer {
  private readonly options: DevTokenIssuerOptions;

  constructor(options: DevTokenIssuerOptions) {
    this.options = options;
  }

  async issue(claims: DevTokenClaims): Promise<string> {
    const nowSeconds = Math.floor(this.options.clock.now().getTime() / 1000);
    const ttl = claims.ttlSeconds ?? 3600;
    return new SignJWT({
      ...(claims.email === undefined ? {} : { email: claims.email }),
      ...(claims.displayName === undefined ? {} : { name: claims.displayName }),
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.options.issuer)
      .setAudience(this.options.audience)
      .setSubject(claims.subject)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + ttl)
      .sign(this.options.secret);
  }
}
