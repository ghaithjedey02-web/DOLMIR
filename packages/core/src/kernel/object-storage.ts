import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { DomainError } from './errors.js';
import { type OrganizationId, OrganizationIdSchema } from './ids.js';
import type { Result } from './result.js';

/**
 * Object storage port (Directive §7 M): raw documents, attachments and other
 * blobs. Content-addressed — the key is derived from the tenant, a namespace
 * and the SHA-256 of the bytes — so the same content stored twice is one
 * object, an object's integrity is verifiable, and evidence can cite an
 * immutable `contentHash`. Keys always begin with the tenant id; adapters
 * refuse to serve an object to a different tenant.
 */

export const StorageNamespaceSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/, 'namespace must be lowercase, digits, _ or -');
export type StorageNamespace = z.infer<typeof StorageNamespaceSchema>;

export const ContentHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'content hash must be SHA-256 hex');
export type ContentHash = z.infer<typeof ContentHashSchema>;

/** `<tenantId>/<namespace>/<sha256>` */
export const ObjectKeySchema = z
  .string()
  .regex(/^[0-9a-f-]{36}\/[a-z][a-z0-9_-]{0,63}\/[0-9a-f]{64}$/, 'malformed object key');
export type ObjectKey = z.infer<typeof ObjectKeySchema>;

export const StoredObjectRefSchema = z
  .object({
    key: ObjectKeySchema,
    tenantId: OrganizationIdSchema,
    namespace: StorageNamespaceSchema,
    contentHash: ContentHashSchema,
    sizeBytes: z.number().int().min(0),
    contentType: z.string().trim().min(1).max(255),
    filename: z.string().trim().min(1).max(255).optional(),
    storedAt: z.date(),
  })
  .strict();
export type StoredObjectRef = z.infer<typeof StoredObjectRefSchema>;

export interface PutObjectInput {
  readonly tenantId: OrganizationId;
  readonly namespace: StorageNamespace;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly filename?: string;
}

export interface StoredObject {
  readonly ref: StoredObjectRef;
  readonly body: Uint8Array;
}

export interface ObjectStoragePort {
  /** Stores the bytes; storing identical content again returns the existing reference. */
  put(input: PutObjectInput): Promise<Result<StoredObjectRef, DomainError>>;
  /** The object, or `undefined` when unknown to this tenant. */
  get(
    tenantId: OrganizationId,
    key: ObjectKey,
  ): Promise<Result<StoredObject | undefined, DomainError>>;
  /** Metadata only. */
  head(
    tenantId: OrganizationId,
    key: ObjectKey,
  ): Promise<Result<StoredObjectRef | undefined, DomainError>>;
}

export function contentHashOf(body: Uint8Array): ContentHash {
  return createHash('sha256').update(body).digest('hex');
}

export function objectKeyFor(
  tenantId: OrganizationId,
  namespace: StorageNamespace,
  contentHash: ContentHash,
): ObjectKey {
  return `${tenantId}/${namespace}/${contentHash}`;
}

/** True when `key` belongs to `tenantId` (the first path segment). */
export function keyBelongsToTenant(key: ObjectKey, tenantId: OrganizationId): boolean {
  return key.startsWith(`${tenantId}/`);
}
