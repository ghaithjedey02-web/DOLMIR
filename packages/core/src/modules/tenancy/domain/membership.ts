import { z } from 'zod';

import { OrganizationIdSchema, UserIdSchema } from '../../../kernel/ids.js';
import { RoleKeySchema } from '../../../kernel/tenant.js';

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
