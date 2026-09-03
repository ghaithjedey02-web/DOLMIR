import { z } from 'zod';

import { ConnectionIdSchema, OrganizationIdSchema } from '../../../kernel/ids.js';

/**
 * A tenant's connection to an outside system (ADR-0013): one row per
 * capability and provider, with non-secret settings in the clear and the
 * credentials as an AES-256-GCM envelope that only the connectors module can
 * open. The API never returns credentials; audit records changes without
 * values.
 */
export const ConnectionCapability = {
  /** A mailbox to read from and reply through. */
  MAILBOX: 'mailbox',
  /** A shared secret that lets a machine caller push raw messages to the ingestion endpoint. */
  INGEST_ENDPOINT: 'ingest_endpoint',
} as const;
export const ConnectionCapabilitySchema = z.enum(['mailbox', 'ingest_endpoint']);
export type ConnectionCapability = z.infer<typeof ConnectionCapabilitySchema>;

export const ConnectionStatusSchema = z.enum(['active', 'disabled', 'error']);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const ProviderKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,49}$/, 'provider key must be snake_case');
export type ProviderKey = z.infer<typeof ProviderKeySchema>;

/** Provider key of the HMAC ingestion endpoint. */
export const INGESTION_ENDPOINT_PROVIDER = 'hmac_v1';

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64');

/** Encrypted credentials as stored. `kid` identifies the key so a wrong key is detected before decrypting. */
export const EncryptedSecretSchema = z
  .object({
    v: z.literal(1),
    alg: z.literal('aes-256-gcm'),
    kid: z.string().length(16),
    nonce: base64,
    ciphertext: base64,
    tag: base64,
  })
  .strict();
export type EncryptedSecret = z.infer<typeof EncryptedSecretSchema>;

export const ConnectionSettingsSchema = z.record(z.string(), z.unknown());
export type ConnectionSettings = z.infer<typeof ConnectionSettingsSchema>;

export const TenantConnectionSchema = z
  .object({
    id: ConnectionIdSchema,
    organizationId: OrganizationIdSchema,
    capability: ConnectionCapabilitySchema,
    provider: ProviderKeySchema,
    displayName: z.string().trim().min(1).max(200),
    /** Non-secret configuration (hosts, ports, mailbox name, sender address). */
    settings: ConnectionSettingsSchema,
    credentials: EncryptedSecretSchema,
    status: ConnectionStatusSchema,
    lastError: z.string().max(2000).nullable(),
    /** Provider cursor (last UID, validity…) so polling resumes where it stopped. */
    syncState: z.record(z.string(), z.unknown()),
    lastSyncAt: z.date().nullable(),
    version: z.number().int().min(1),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();
export type TenantConnection = z.infer<typeof TenantConnectionSchema>;

/** What leaves the module: everything but the credentials. */
export type ConnectionView = Omit<TenantConnection, 'credentials'>;

export function toConnectionView(connection: TenantConnection): ConnectionView {
  const { credentials: _credentials, ...view } = connection;
  return view;
}
