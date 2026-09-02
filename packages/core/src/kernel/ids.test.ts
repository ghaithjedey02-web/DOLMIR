import { describe, expect, it } from 'vitest';

import {
  OrganizationIdSchema,
  UserIdSchema,
  newCorrelationId,
  newOrganizationId,
  newRequestId,
  newUserId,
  newUuid,
  parseId,
} from './ids.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('ids', () => {
  it('generates RFC 4122 identifiers for every branded type', () => {
    for (const id of [
      newUuid(),
      newOrganizationId(),
      newUserId(),
      newRequestId(),
      newCorrelationId(),
    ]) {
      expect(id).toMatch(UUID);
    }
  });

  it('parses valid ids and rejects malformed ones as values', () => {
    const valid = parseId(
      OrganizationIdSchema,
      '9f6b1c1e-1e4a-4a9b-8f7f-3a1c2d3e4f50',
      'organizationId',
    );
    expect(valid.ok).toBe(true);

    const invalid = parseId(UserIdSchema, 'not-a-uuid', 'userId');
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.code).toBe('INVALID_ID');
    expect(invalid.error.message).toContain('userId');
  });

  it('brands distinct id types so they are not interchangeable at the type level', () => {
    const organizationId = newOrganizationId();
    // @ts-expect-error — an OrganizationId is not a UserId.
    const asUser: ReturnType<typeof newUserId> = organizationId;
    expect(asUser).toBe(organizationId);
  });
});
