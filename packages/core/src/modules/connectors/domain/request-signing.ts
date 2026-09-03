import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { UnauthenticatedError } from '../../../kernel/errors.js';
import { err, ok, type Result } from '../../../kernel/result.js';

/**
 * Request signing for the raw-MIME ingestion endpoint (ADR-0013 §3a). The
 * caller signs `v1 \n keyId \n timestamp \n nonce \n sha256(body)` with the
 * shared secret; the platform checks the clock skew, the signature (constant
 * time) and, in the use case, that the nonce was never seen. No session, no
 * OAuth application, works from a forwarding rule or a script.
 */
export const INGESTION_SIGNATURE_VERSION = 'v1';

export const INGESTION_HEADER_NAMES = {
  keyId: 'x-dolmir-key-id',
  timestamp: 'x-dolmir-timestamp',
  nonce: 'x-dolmir-nonce',
  signature: 'x-dolmir-signature',
} as const;

export const IngestionKeyIdSchema = z.string().regex(/^ik_[a-f0-9]{16}$/);

/**
 * The four headers under the names the transport actually carries, so
 * verification takes a request as received and no caller has to translate
 * between HTTP names and internal ones and get it subtly wrong.
 */
export const IngestionSignatureHeadersSchema = z.object({
  [INGESTION_HEADER_NAMES.keyId]: IngestionKeyIdSchema,
  /** Unix seconds. */
  [INGESTION_HEADER_NAMES.timestamp]: z.string().regex(/^\d{1,12}$/),
  [INGESTION_HEADER_NAMES.nonce]: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  /** Lowercase hex HMAC-SHA256. */
  [INGESTION_HEADER_NAMES.signature]: z.string().regex(/^[a-f0-9]{64}$/),
});
export type IngestionSignatureHeaders = z.infer<typeof IngestionSignatureHeadersSchema>;

export interface IngestionSignatureInput {
  readonly keyId: string;
  /** Unix seconds. */
  readonly timestamp: number;
  readonly nonce: string;
  readonly body: Uint8Array;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function ingestionStringToSign(input: IngestionSignatureInput): string {
  return [
    INGESTION_SIGNATURE_VERSION,
    input.keyId,
    String(input.timestamp),
    input.nonce,
    sha256Hex(input.body),
  ].join('\n');
}

export function signIngestionRequest(secret: Uint8Array, input: IngestionSignatureInput): string {
  return createHmac('sha256', Buffer.from(secret))
    .update(ingestionStringToSign(input))
    .digest('hex');
}

export interface VerifiedIngestionSignature {
  readonly keyId: string;
  readonly nonce: string;
  readonly timestamp: Date;
}

export function verifyIngestionSignature(
  secret: Uint8Array,
  rawHeaders: Readonly<Record<string, unknown>>,
  body: Uint8Array,
  now: Date,
  toleranceSeconds = 300,
): Result<VerifiedIngestionSignature, UnauthenticatedError> {
  const parsed = IngestionSignatureHeadersSchema.safeParse(rawHeaders);
  if (!parsed.success) {
    return err(
      new UnauthenticatedError(
        'INVALID_SIGNATURE_HEADERS',
        'The request signature headers are missing or malformed.',
      ),
    );
  }
  const headers = {
    keyId: parsed.data[INGESTION_HEADER_NAMES.keyId],
    timestamp: parsed.data[INGESTION_HEADER_NAMES.timestamp],
    nonce: parsed.data[INGESTION_HEADER_NAMES.nonce],
    signature: parsed.data[INGESTION_HEADER_NAMES.signature],
  };
  const timestamp = Number(headers.timestamp);
  const skew = Math.abs(now.getTime() / 1000 - timestamp);
  if (skew > toleranceSeconds) {
    return err(
      new UnauthenticatedError(
        'SIGNATURE_EXPIRED',
        'The request timestamp is outside the accepted window.',
        {
          details: { toleranceSeconds },
        },
      ),
    );
  }
  const expected = signIngestionRequest(secret, {
    keyId: headers.keyId,
    timestamp,
    nonce: headers.nonce,
    body,
  });
  const given = Buffer.from(headers.signature, 'hex');
  const wanted = Buffer.from(expected, 'hex');
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return err(
      new UnauthenticatedError('INVALID_SIGNATURE', 'The request signature does not match.'),
    );
  }
  return ok({
    keyId: headers.keyId,
    nonce: headers.nonce,
    timestamp: new Date(timestamp * 1000),
  });
}
