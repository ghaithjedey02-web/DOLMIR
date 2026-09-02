import { describe, expect, it } from 'vitest';

import {
  FixedClock,
  type ObjectKey,
  type ObjectStoragePort,
  contentHashOf,
  newOrganizationId,
} from '@dolmir/core';

/**
 * The ObjectStoragePort contract (plan §L): every adapter must pass this
 * suite unchanged. "Swappable" is a tested property.
 */
export type ObjectStorageFactory = (
  clock: FixedClock,
) => Promise<{ storage: ObjectStoragePort; cleanup: () => Promise<void> }>;

export function describeObjectStorageContract(name: string, factory: ObjectStorageFactory): void {
  describe(`ObjectStoragePort contract — ${name}`, () => {
    const clock = new FixedClock(new Date('2026-09-02T14:00:00.000Z'));
    const tenantA = newOrganizationId();
    const tenantB = newOrganizationId();
    const text = new TextEncoder().encode('Richiesta di offerta — flangia tornita, 250 pz');

    const withStorage = async (fn: (storage: ObjectStoragePort) => Promise<void>) => {
      const { storage, cleanup } = await factory(clock);
      try {
        await fn(storage);
      } finally {
        await cleanup();
      }
    };

    it('stores bytes under a content-addressed key and returns a complete reference', () =>
      withStorage(async (storage) => {
        const result = await storage.put({
          tenantId: tenantA,
          namespace: 'documents',
          body: text,
          contentType: 'text/plain; charset=utf-8',
          filename: 'rdo.txt',
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toEqual({
          key: `${tenantA}/documents/${contentHashOf(text)}`,
          tenantId: tenantA,
          namespace: 'documents',
          contentHash: contentHashOf(text),
          sizeBytes: text.byteLength,
          contentType: 'text/plain; charset=utf-8',
          filename: 'rdo.txt',
          storedAt: clock.now(),
        });
      }));

    it('is idempotent for identical content and keeps the first metadata', () =>
      withStorage(async (storage) => {
        const first = await storage.put({
          tenantId: tenantA,
          namespace: 'documents',
          body: text,
          contentType: 'text/plain',
        });
        clock.advance(60_000);
        const second = await storage.put({
          tenantId: tenantA,
          namespace: 'documents',
          body: Uint8Array.from(text),
          contentType: 'application/octet-stream',
        });
        expect(first.ok && second.ok).toBe(true);
        if (first.ok && second.ok) expect(second.value).toEqual(first.value);
      }));

    it('round-trips binary content byte for byte, with head returning metadata only', () =>
      withStorage(async (storage) => {
        const binary = new Uint8Array(70_000);
        for (let i = 0; i < binary.length; i += 1) binary[i] = (i * 31) % 256;
        const put = await storage.put({
          tenantId: tenantA,
          namespace: 'attachments',
          body: binary,
          contentType: 'application/pdf',
        });
        if (!put.ok) throw new Error(put.error.message);
        const got = await storage.get(tenantA, put.value.key);
        expect(got.ok).toBe(true);
        if (!got.ok || got.value === undefined) throw new Error('missing object');
        expect(Buffer.from(got.value.body).equals(Buffer.from(binary))).toBe(true);
        expect(got.value.ref).toEqual(put.value);
        const head = await storage.head(tenantA, put.value.key);
        expect(head.ok && head.value).toEqual(put.value);
      }));

    it('never serves an object to another tenant, and reports unknown keys as absent', () =>
      withStorage(async (storage) => {
        const put = await storage.put({
          tenantId: tenantA,
          namespace: 'documents',
          body: text,
          contentType: 'text/plain',
        });
        if (!put.ok) throw new Error(put.error.message);
        const foreign = await storage.get(tenantB, put.value.key);
        expect(foreign.ok).toBe(false);
        if (!foreign.ok) expect(foreign.error.code).toBe('OBJECT_TENANT_MISMATCH');

        const unknown: ObjectKey = `${tenantA}/documents/${'0'.repeat(64)}`;
        const missing = await storage.get(tenantA, unknown);
        expect(missing.ok).toBe(true);
        if (missing.ok) expect(missing.value).toBeUndefined();
        const missingHead = await storage.head(tenantA, unknown);
        expect(missingHead.ok && missingHead.value === undefined).toBe(true);
      }));

    it('rejects malformed keys, namespaces and empty bodies as values', () =>
      withStorage(async (storage) => {
        const badKey = await storage.get(tenantA, '../../etc/passwd');
        expect(badKey.ok).toBe(false);
        if (!badKey.ok) expect(badKey.error.code).toBe('INVALID_OBJECT_KEY');

        const badNamespace = await storage.put({
          tenantId: tenantA,
          namespace: '../escape',
          body: text,
          contentType: 'text/plain',
        });
        expect(badNamespace.ok).toBe(false);
        if (!badNamespace.ok) expect(badNamespace.error.code).toBe('INVALID_OBJECT');

        const empty = await storage.put({
          tenantId: tenantA,
          namespace: 'documents',
          body: new Uint8Array(0),
          contentType: 'text/plain',
        });
        expect(empty.ok).toBe(false);
        if (!empty.ok) expect(empty.error.code).toBe('EMPTY_OBJECT');
      }));

    it('tolerates concurrent puts of the same content', () =>
      withStorage(async (storage) => {
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            storage.put({
              tenantId: tenantA,
              namespace: 'documents',
              body: text,
              contentType: 'text/plain',
            }),
          ),
        );
        expect(results.every((r) => r.ok)).toBe(true);
        const keys = new Set(results.map((r) => (r.ok ? r.value.key : 'error')));
        expect(keys.size).toBe(1);
      }));
  });
}
