import { z } from 'zod';

import { OrganizationIdSchema } from '../../../kernel/ids.js';

/** URL-safe, lowercase, 1–63 characters; the public handle of a tenant. */
export const OrganizationSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/, 'must be lowercase letters, digits and hyphens');
export type OrganizationSlug = z.infer<typeof OrganizationSlugSchema>;

export const OrganizationStatus = { ACTIVE: 'active', SUSPENDED: 'suspended' } as const;
export const OrganizationStatusSchema = z.enum(['active', 'suspended']);
export type OrganizationStatus = z.infer<typeof OrganizationStatusSchema>;

export const OrganizationSchema = z
  .object({
    id: OrganizationIdSchema,
    slug: OrganizationSlugSchema,
    name: z.string().trim().min(1).max(200),
    status: OrganizationStatusSchema,
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();
export type Organization = z.infer<typeof OrganizationSchema>;

export const NewOrganizationSchema = z
  .object({
    slug: OrganizationSlugSchema,
    name: z.string().trim().min(1).max(200),
  })
  .strict();
export type NewOrganization = z.infer<typeof NewOrganizationSchema>;
