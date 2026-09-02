import { z } from 'zod';

import { InternalError, validationErrorFromZod } from '../../../../kernel/errors.js';
import { OrganizationIdSchema, UserIdSchema } from '../../../../kernel/ids.js';
import { type Membership, MembershipSchema, RoleKeySchema } from '../../domain/membership.js';
import { type Organization, OrganizationSchema } from '../../domain/organization.js';
import { type User, UserSchema } from '../../domain/user.js';

/**
 * Row schemas: the database is trusted, but its output is still validated so
 * a schema drift surfaces as a loud error at the boundary, never as a subtle
 * bug downstream.
 */

export const OrganizationRowSchema = z.object({
  id: OrganizationIdSchema,
  slug: z.string(),
  name: z.string(),
  status: z.enum(['active', 'suspended']),
  created_at: z.date(),
  updated_at: z.date(),
});

export const UserRowSchema = z.object({
  id: UserIdSchema,
  auth_subject: z.string(),
  email: z.string().nullable(),
  display_name: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

export const MembershipRowSchema = z.object({
  organization_id: OrganizationIdSchema,
  user_id: UserIdSchema,
  role_key: RoleKeySchema,
  status: z.enum(['active', 'revoked']),
  created_at: z.date(),
  updated_at: z.date(),
});

export function parseRow<S extends z.ZodType>(schema: S, row: unknown, table: string): z.output<S> {
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    throw new InternalError('ROW_SHAPE_MISMATCH', `A row of ${table} did not match its schema.`, {
      cause: validationErrorFromZod(parsed.error),
      details: { table },
    });
  }
  return parsed.data;
}

export const toOrganization = (row: z.infer<typeof OrganizationRowSchema>): Organization =>
  OrganizationSchema.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export const toUser = (row: z.infer<typeof UserRowSchema>): User =>
  UserSchema.parse({
    id: row.id,
    authSubject: row.auth_subject,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export const toMembership = (row: z.infer<typeof MembershipRowSchema>): Membership =>
  MembershipSchema.parse({
    organizationId: row.organization_id,
    userId: row.user_id,
    roleKey: row.role_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
