import { z } from 'zod';

import { OrganizationIdSchema, UserIdSchema } from '../../../kernel/ids.js';

/**
 * What the company is, in its own words — the stable part of company memory
 * (Direction §14). Read by every AI System as context and cited as
 * RECORD_FIELD evidence; never a free-text prompt blob.
 */
export const LanguageCodeSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'ISO 639-1 language code');

export const CompanyProfileSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    legalName: z.string().trim().min(1).max(300),
    /** Free sector label ("lavorazioni meccaniche di precisione"). */
    sector: z.string().trim().min(1).max(200).nullable(),
    /** What the company does and sells, for models and for people. */
    description: z.string().trim().min(1).max(4000).nullable(),
    /** Languages the company works in; the first is the default for outgoing text. */
    languages: z.array(LanguageCodeSchema).min(1).max(10),
    timezone: z.string().trim().min(1).max(64),
    /** Appended to outgoing drafts. */
    signature: z.string().trim().min(1).max(2000).nullable(),
    version: z.number().int().min(1),
    updatedAt: z.date(),
    updatedBy: UserIdSchema.nullable(),
  })
  .strict();
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;

export const CompanyProfilePatchSchema = z
  .object({
    legalName: z.string().trim().min(1).max(300).optional(),
    sector: z.string().trim().min(1).max(200).nullable().optional(),
    description: z.string().trim().min(1).max(4000).nullable().optional(),
    languages: z.array(LanguageCodeSchema).min(1).max(10).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    signature: z.string().trim().min(1).max(2000).nullable().optional(),
  })
  .strict();
export type CompanyProfilePatch = z.infer<typeof CompanyProfilePatchSchema>;

export function defaultCompanyProfile(
  organizationId: CompanyProfile['organizationId'],
  legalName: string,
  now: Date,
): CompanyProfile {
  return {
    organizationId,
    legalName,
    sector: null,
    description: null,
    languages: ['it'],
    timezone: 'Europe/Rome',
    signature: null,
    version: 0,
    updatedAt: now,
    updatedBy: null,
  };
}
