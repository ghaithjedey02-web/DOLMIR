import { z } from 'zod';

import { OrganizationIdSchema, UserIdSchema } from '../../../kernel/ids.js';

/**
 * Role keys are data owned by tenancy; the access module maps each key to a
 * permission set. Adding a role means a migration (the CHECK constraint) and
 * a permission set — never a schema redesign.
 */
export const ROLE_KEYS = ['owner', 'admin', 'operator', 'viewer'] as const;
export const RoleKeySchema = z.enum(ROLE_KEYS);
export type RoleKey = z.infer<typeof RoleKeySchema>;

export const MembershipStatus = { ACTIVE: 'active', REVOKED: 'revoked' } as const;
export const MembershipStatusSchema = z.enum(['active', 'revoked']);
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;

export const MembershipSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    userId: UserIdSchema,
    roleKey: RoleKeySchema,
    status: MembershipStatusSchema,
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();
export type Membership = z.infer<typeof MembershipSchema>;

export const NewMembershipSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    userId: UserIdSchema,
    roleKey: RoleKeySchema,
  })
  .strict();
export type NewMembership = z.infer<typeof NewMembershipSchema>;
