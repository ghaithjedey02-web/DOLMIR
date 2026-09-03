import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { type DomainError, InternalError } from '../../../kernel/errors.js';
import type { OrganizationId } from '../../../kernel/ids.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import { type EncryptedSecret, EncryptedSecretSchema } from './connection.js';

/**
 * AES-256-GCM for per-tenant credentials (ADR-0013 §2). The tenant id is the
 * associated data, so an envelope copied onto another tenant's row does not
 * decrypt. The key comes from `DOLMIR_SECRETS_KEY`; its fingerprint travels
 * with every envelope so a rotated or wrong key is reported, not guessed.
 */
export class CredentialCipher {
  private readonly key: Buffer;
  /** First 16 hex characters of the key's SHA-256: identifies the key, reveals nothing about it. */
  readonly keyId: string;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) {
      throw new InternalError('INVALID_SECRETS_KEY', 'The secrets key must be exactly 32 bytes.');
    }
    this.key = Buffer.from(key);
    this.keyId = createHash('sha256').update(this.key).digest('hex').slice(0, 16);
  }

  static fromBase64(value: string): CredentialCipher {
    return new CredentialCipher(Buffer.from(value, 'base64'));
  }

  /** A fresh random key, base64 — for `dolmir secrets:generate-key` and tests. */
  static generateKeyBase64(): string {
    return randomBytes(32).toString('base64');
  }

  encrypt(tenantId: OrganizationId, plaintext: Readonly<Record<string, unknown>>): EncryptedSecret {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(tenantId, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(plaintext), 'utf8'),
      cipher.final(),
    ]);
    return EncryptedSecretSchema.parse({
      v: 1,
      alg: 'aes-256-gcm',
      kid: this.keyId,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    });
  }

  decrypt(
    tenantId: OrganizationId,
    secret: EncryptedSecret,
  ): Result<Record<string, unknown>, DomainError> {
    if (secret.kid !== this.keyId) {
      return err(
        new InternalError(
          'CREDENTIAL_KEY_MISMATCH',
          'The credentials were encrypted with a different secrets key.',
          { details: { kid: secret.kid, current: this.keyId } },
        ),
      );
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(secret.nonce, 'base64'),
      );
      decipher.setAAD(Buffer.from(tenantId, 'utf8'));
      decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
      const json = Buffer.concat([
        decipher.update(Buffer.from(secret.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return err(
          new InternalError('CREDENTIAL_SHAPE_INVALID', 'Decrypted credentials are not an object.'),
        );
      }
      return ok(parsed as Record<string, unknown>);
    } catch {
      // Authentication failure: wrong key, wrong tenant (associated data) or tampered bytes.
      return err(
        new InternalError(
          'CREDENTIAL_DECRYPTION_FAILED',
          'The credentials could not be decrypted: wrong tenant, wrong key or tampered data.',
        ),
      );
    }
  }
}
