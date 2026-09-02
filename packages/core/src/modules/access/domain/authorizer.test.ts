import { describe, expect, it } from 'vitest';

import { ROLE_KEYS } from '../../../kernel/tenant.js';
import { Authorizer } from './authorizer.js';
import {
  ALL_PERMISSIONS,
  Permission,
  ROLE_MATRIX_VERSION,
  ROLE_PERMISSIONS,
} from './permissions.js';

const authorizer = new Authorizer();

describe('role matrix', () => {
  it('is defined for every role key tenancy knows', () => {
    for (const role of ROLE_KEYS) {
      expect(ROLE_PERMISSIONS[role]).toBeInstanceOf(Set);
    }
  });

  it('grants exactly the intended permissions (explicit, reviewed matrix)', () => {
    const matrix = Object.fromEntries(
      ROLE_KEYS.map((role) => [role, [...authorizer.permissionsFor(role)].sort()]),
    );
    expect(matrix).toEqual({
      owner: [...ALL_PERMISSIONS].sort(),
      admin: [
        'ai:invoke',
        'audit:read',
        'decisions:approve',
        'ledger:append',
        'ledger:read',
        'members:manage',
        'members:read',
        'organization:read',
      ],
      operator: [
        'ai:invoke',
        'decisions:approve',
        'ledger:append',
        'ledger:read',
        'members:read',
        'organization:read',
      ],
      viewer: ['ledger:read', 'members:read', 'organization:read'],
    });
  });

  it('reserves organization management for owners', () => {
    expect(authorizer.can({ roleKey: 'owner' }, Permission.ORGANIZATION_MANAGE)).toBe(true);
    for (const role of ['admin', 'operator', 'viewer'] as const) {
      expect(authorizer.can({ roleKey: role }, Permission.ORGANIZATION_MANAGE)).toBe(false);
    }
  });
});

describe('Authorizer.require', () => {
  it('returns the decision when allowed and a ForbiddenError with details when denied', () => {
    const allowed = authorizer.require({ roleKey: 'operator' }, Permission.DECISIONS_APPROVE);
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.value).toEqual({
        allowed: true,
        permission: 'decisions:approve',
        roleKey: 'operator',
        matrixVersion: ROLE_MATRIX_VERSION,
      });
    }

    const denied = authorizer.require({ roleKey: 'viewer' }, Permission.LEDGER_APPEND);
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('PERMISSION_DENIED');
    expect(denied.error.category).toBe('forbidden');
    expect(denied.error.details).toEqual({
      permission: 'ledger:append',
      roleKey: 'viewer',
      matrixVersion: ROLE_MATRIX_VERSION,
    });
  });
});
