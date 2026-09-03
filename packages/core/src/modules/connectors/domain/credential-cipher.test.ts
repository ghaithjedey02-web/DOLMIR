import { describe, expect, it } from 'vitest';

import { newOrganizationId } from '../../../kernel/ids.js';
import { CredentialCipher } from './credential-cipher.js';
import {
  INGESTION_HEADER_NAMES,
  signIngestionRequest,
  verifyIngestionSignature,
} from './request-signing.js';

describe('CredentialCipher', () => {
  const tenantA = newOrganizationId();
  const tenantB = newOrganizationId();
  const key = CredentialCipher.generateKeyBase64();
  const cipher = CredentialCipher.fromBase64(key);

  it('round-trips credentials, never stores them in the clear, and binds them to the tenant', () => {
    const envelope = cipher.encrypt(tenantA, { user: 'acquisti@a.test', pass: 'p4ss-w0rd' });
    expect(envelope).toMatchObject({ v: 1, alg: 'aes-256-gcm', kid: cipher.keyId });
    expect(JSON.stringify(envelope)).not.toContain('p4ss-w0rd');
    expect(JSON.stringify(envelope)).not.toContain('acquisti');
    const back = cipher.decrypt(tenantA, envelope);
    expect(back.ok && back.value).toEqual({ user: 'acquisti@a.test', pass: 'p4ss-w0rd' });

    const otherTenant = cipher.decrypt(tenantB, envelope);
    expect(!otherTenant.ok && otherTenant.error.code).toBe('CREDENTIAL_DECRYPTION_FAILED');

    const tampered = {
      ...envelope,
      ciphertext: envelope.ciphertext.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')),
    };
    const broken = cipher.decrypt(tenantA, tampered);
    expect(!broken.ok && broken.error.code).toBe('CREDENTIAL_DECRYPTION_FAILED');

    const otherKey = CredentialCipher.fromBase64(CredentialCipher.generateKeyBase64());
    const wrongKey = otherKey.decrypt(tenantA, envelope);
    expect(!wrongKey.ok && wrongKey.error.code).toBe('CREDENTIAL_KEY_MISMATCH');
    expect(() => new CredentialCipher(new Uint8Array(16))).toThrow(/32 bytes/);
    expect(cipher.encrypt(tenantA, { a: 1 }).nonce).not.toBe(
      cipher.encrypt(tenantA, { a: 1 }).nonce,
    );
  });
});

describe('ingestion request signing', () => {
  const secret = Buffer.from(CredentialCipher.generateKeyBase64(), 'base64');
  const body = new TextEncoder().encode('From: a@b.test\r\nSubject: hi\r\n\r\nbody');
  const now = new Date('2026-09-03T12:00:00.000Z');
  const timestamp = Math.floor(now.getTime() / 1000);
  const keyId = 'ik_0123456789abcdef';
  const nonce = 'n0nce-n0nce-n0nce-01';
  const headers = () => ({
    keyId,
    timestamp: String(timestamp),
    nonce,
    signature: signIngestionRequest(secret, { keyId, timestamp, nonce, body }),
  });

  it('accepts a fresh, correctly signed request and names the headers it expects', () => {
    const verified = verifyIngestionSignature(secret, headers(), body, now);
    expect(verified.ok && verified.value).toEqual({ keyId, nonce, timestamp: now });
    expect(Object.values(INGESTION_HEADER_NAMES)).toEqual([
      'x-dolmir-key-id',
      'x-dolmir-timestamp',
      'x-dolmir-nonce',
      'x-dolmir-signature',
    ]);
  });

  it('rejects skew, tampering, a wrong secret and malformed headers', () => {
    const late = verifyIngestionSignature(
      secret,
      headers(),
      body,
      new Date(now.getTime() + 301_000),
    );
    expect(!late.ok && late.error.code).toBe('SIGNATURE_EXPIRED');
    const otherBody = verifyIngestionSignature(
      secret,
      headers(),
      new TextEncoder().encode('x'),
      now,
    );
    expect(!otherBody.ok && otherBody.error.code).toBe('INVALID_SIGNATURE');
    const wrongSecret = verifyIngestionSignature(Buffer.alloc(32, 1), headers(), body, now);
    expect(!wrongSecret.ok && wrongSecret.error.code).toBe('INVALID_SIGNATURE');
    const malformed = verifyIngestionSignature(
      secret,
      { ...headers(), signature: 'zz' },
      body,
      now,
    );
    expect(!malformed.ok && malformed.error.code).toBe('INVALID_SIGNATURE_HEADERS');
    const missing = verifyIngestionSignature(secret, {}, body, now);
    expect(!missing.ok && missing.error.category).toBe('unauthenticated');
  });
});
