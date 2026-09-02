import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type Upcaster, upcastToVersion, versionedSchema } from './schema-version.js';

describe('schema versioning', () => {
  const v1toV2: Upcaster = {
    from: 1,
    to: 2,
    upcast: (doc) => ({ ...doc, schemaVersion: 2, quantity: { value: doc['qty'], unit: 'pz' } }),
  };
  const v2toV3: Upcaster = {
    from: 2,
    to: 3,
    upcast: (doc) => ({ ...doc, schemaVersion: 3, source: 'legacy' }),
  };

  it('chains upcasters to the target version', () => {
    const result = upcastToVersion({ schemaVersion: 1, qty: 5 }, 3, [v2toV3, v1toV2]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      schemaVersion: 3,
      quantity: { value: 5, unit: 'pz' },
      source: 'legacy',
    });
  });

  it('is a no-op when already current and fails loudly when a step is missing or the document is newer', () => {
    expect(upcastToVersion({ schemaVersion: 3 }, 3, []).ok).toBe(true);
    const missing = upcastToVersion({ schemaVersion: 1 }, 3, [v2toV3]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('UPCASTER_MISSING');
    const newer = upcastToVersion({ schemaVersion: 4 }, 3, []);
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.error.code).toBe('SCHEMA_VERSION_TOO_NEW');
  });

  it('rejects an upcaster that lies about its output version', () => {
    const liar: Upcaster = { from: 1, to: 2, upcast: (doc) => ({ ...doc, schemaVersion: 7 }) };
    const result = upcastToVersion({ schemaVersion: 1 }, 2, [liar]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UPCASTER_INVALID');
  });

  it('pins schemaVersion to a literal in versioned schemas', () => {
    const schema = versionedSchema(2, { name: z.string() });
    expect(schema.safeParse({ schemaVersion: 2, name: 'x' }).success).toBe(true);
    expect(schema.safeParse({ schemaVersion: 1, name: 'x' }).success).toBe(false);
    expect(schema.safeParse({ schemaVersion: 2, name: 'x', extra: 1 }).success).toBe(false);
  });
});
