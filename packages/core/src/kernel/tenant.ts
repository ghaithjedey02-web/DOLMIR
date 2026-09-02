import { z } from 'zod';

import type { OrganizationId, UserId } from './ids.js';

/**
 * The tenant vocabulary shared by every module: which roles exist (tenancy
 * stores them, access maps them to permissions, audit records them) and the
 * resolved answer to "who is acting, in which organisation, as what".
 *
 * Adding a role means a migration (the CHECK constraint on memberships) and a
 * permission set in the access module — never a schema redesign.
 */
export const ROLE_KEYS = ['owner', 'admin', 'operator', 'viewer'] as const;
export const RoleKeySchema = z.enum(ROLE_KEYS);
export type RoleKey = z.infer<typeof RoleKeySchema>;

/**
 * Produced once per request after authentication and membership resolution;
 * every tenant-scoped use case receives it and never re-derives it from
 * client input.
 */
export interface TenantContext {
  readonly organizationId: OrganizationId;
  readonly organizationSlug: string;
  readonly userId: UserId;
  readonly roleKey: RoleKey;
}
