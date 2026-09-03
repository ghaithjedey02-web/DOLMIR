import type { RoleKey } from '../../../kernel/tenant.js';

/**
 * Permissions are named constants of the form `<resource>:<action>`. Tools,
 * routes and use cases declare the permission they need; the `Authorizer`
 * answers deterministically from the role matrix below. No LLM, no I/O.
 */
export const Permission = {
  ORGANIZATION_READ: 'organization:read',
  ORGANIZATION_MANAGE: 'organization:manage',
  MEMBERS_READ: 'members:read',
  MEMBERS_MANAGE: 'members:manage',
  AUDIT_READ: 'audit:read',
  LEDGER_READ: 'ledger:read',
  LEDGER_APPEND: 'ledger:append',
  AI_INVOKE: 'ai:invoke',
  /** The human gate: approving or rejecting a proposed action. */
  DECISIONS_APPROVE: 'decisions:approve',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

/**
 * The role matrix, versioned so audit records can say which matrix granted an
 * action. Changing a row is a reviewed change with a version bump; custom
 * per-tenant roles are a later addition behind the same `Authorizer` API.
 */
export const ROLE_MATRIX_VERSION = 1;

export const ROLE_PERMISSIONS: Readonly<Record<RoleKey, ReadonlySet<Permission>>> = {
  owner: new Set(ALL_PERMISSIONS),
  admin: new Set([
    Permission.ORGANIZATION_READ,
    Permission.MEMBERS_READ,
    Permission.MEMBERS_MANAGE,
    Permission.AUDIT_READ,
    Permission.LEDGER_READ,
    Permission.LEDGER_APPEND,
    Permission.AI_INVOKE,
    Permission.DECISIONS_APPROVE,
  ]),
  operator: new Set([
    Permission.ORGANIZATION_READ,
    Permission.MEMBERS_READ,
    Permission.LEDGER_READ,
    Permission.LEDGER_APPEND,
    Permission.AI_INVOKE,
    Permission.DECISIONS_APPROVE,
  ]),
  viewer: new Set([Permission.ORGANIZATION_READ, Permission.MEMBERS_READ, Permission.LEDGER_READ]),
};

/**
 * Permissions only a human may exercise (ADR-0011). An AI actor never holds
 * them, whatever role it acts on behalf of: approval is a human act.
 */
export const HUMAN_ONLY_PERMISSIONS: ReadonlySet<Permission> = new Set([
  Permission.DECISIONS_APPROVE,
]);
