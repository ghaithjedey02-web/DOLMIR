import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../../../kernel/clock.js';
import { DevTokenIssuer } from '../dev/dev-token-issuer.js';
import { JwtVerifier } from './jwt-verifier.js';

const ISSUER = 'http://localhost:3000/dev-auth';
const AUDIENCE = 'dolmir';
const secret = new TextEncoder().encode('dev-only-secret-change-me-please-32chars');

describe('JwtVerifier (HS256)', () => {
  const clock = new FixedClock(new Date('2026-09-02T10:00:00.000Z'));
  const issuer = new DevTokenIssuer({ issuer: ISSUER, audience: AUDIENCE, secret, clock });
  const verifier = new JwtVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    key: { kind: 'hs256', secret },
    clock,
  });

  it('verifies a token minted by the dev issuer and extracts the principal', async () => {
    const token = await issuer.issue({
      subject: 'auth|rossi',
      email: 'Titolare@Officina.Example',
      displayName: 'Mario Rossi',
    });
    const result = await verifier.verify(token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      kind: 'user',
      subject: 'auth|rossi',
      issuer: ISSUER,
      email: 'titolare@officina.example',
      displayName: 'Mario Rossi',
      expiresAt: new Date('2026-09-02T11:00:00.000Z'),
    });
  });

  it('rejects expired tokens using the injected clock', async () => {
    const token = await issuer.issue({ subject: 'auth|rossi', ttlSeconds: 60 });
    const later = new JwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      key: { kind: 'hs256', secret },
      clock: new FixedClock(new Date('2026-09-02T10:05:00.000Z')),
    });
    const result = await later.verify(token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TOKEN_EXPIRED');
    expect(result.error.details).toEqual({ reason: 'ERR_JWT_EXPIRED' });
  });

  it('rejects wrong audience, wrong issuer, wrong secret and garbage, never echoing the token', async () => {
    const wrongAudience = await new DevTokenIssuer({
      issuer: ISSUER,
      audience: 'other',
      secret,
      clock,
    }).issue({ subject: 's' });
    const wrongIssuer = await new DevTokenIssuer({
      issuer: 'https://evil.example',
      audience: AUDIENCE,
      secret,
      clock,
    }).issue({ subject: 's' });
    const wrongSecret = await new DevTokenIssuer({
      issuer: ISSUER,
      audience: AUDIENCE,
      secret: new TextEncoder().encode('another-secret-that-is-long-enough-32'),
      clock,
    }).issue({ subject: 's' });

    for (const token of [wrongAudience, wrongIssuer, wrongSecret, 'not.a.jwt', '']) {
      const result = await verifier.verify(token);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(['INVALID_TOKEN', 'MISSING_TOKEN']).toContain(result.error.code);
      expect(JSON.stringify(result.error.toRecord())).not.toContain(token.slice(0, 20) || 'x');
    }
  });

  it('refuses a token that carries no subject', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(clock.now().getTime() / 1000))
      .setExpirationTime(Math.floor(clock.now().getTime() / 1000) + 60)
      .sign(secret);
    const result = await verifier.verify(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details['reason']).toBe('CLAIMS_INVALID');
  });

  it('does not accept asymmetric algorithms when configured for HS256', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('s')
      .setExpirationTime(Math.floor(clock.now().getTime() / 1000) + 60)
      .sign(privateKey);
    const result = await verifier.verify(token);
    expect(result.ok).toBe(false);
  });
});

describe('JwtVerifier (JWKS)', () => {
  it('verifies an ES256 token against a key set and rejects a foreign key', async () => {
    const clock = new FixedClock(new Date('2026-09-02T10:00:00.000Z'));
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
    const verifier = new JwtVerifier({
      issuer: 'https://project.supabase.co/auth/v1',
      audience: 'authenticated',
      key: { kind: 'jwks', getKey: createLocalJWKSet({ keys: [jwk] }) },
      clock,
    });
    const mint = async (key: Parameters<SignJWT['sign']>[0]) =>
      new SignJWT({ email: 'user@example.test' })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
        .setIssuer('https://project.supabase.co/auth/v1')
        .setAudience('authenticated')
        .setSubject('8f1c9a4e-1111-4222-8333-444455556666')
        .setExpirationTime(Math.floor(clock.now().getTime() / 1000) + 300)
        .sign(key);

    const good = await verifier.verify(await mint(privateKey));
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value.subject).toBe('8f1c9a4e-1111-4222-8333-444455556666');

    const { privateKey: foreign } = await generateKeyPair('ES256');
    const bad = await verifier.verify(await mint(foreign));
    expect(bad.ok).toBe(false);
  });
});
