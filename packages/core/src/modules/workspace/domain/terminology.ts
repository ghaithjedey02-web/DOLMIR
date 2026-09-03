import { z } from 'zod';

import { OrganizationIdSchema, UuidSchema } from '../../../kernel/ids.js';

/**
 * The company's own words: what "RdO", "commessa" or a product nickname mean
 * here. Given to models as context and used by deterministic classification.
 */
export const TermSchema = z
  .object({
    id: UuidSchema,
    organizationId: OrganizationIdSchema,
    term: z.string().trim().min(1).max(100),
    /** Lowercase, trimmed, single spaces — the uniqueness key. */
    termKey: z.string().min(1).max(100),
    meaning: z.string().trim().min(1).max(2000),
    examples: z.array(z.string().trim().min(1).max(500)).max(20),
    active: z.boolean(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();
export type Term = z.infer<typeof TermSchema>;

export const TermInputSchema = z
  .object({
    term: z.string().trim().min(1).max(100),
    meaning: z.string().trim().min(1).max(2000),
    examples: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    active: z.boolean().default(true),
  })
  .strict();
export type TermInput = z.input<typeof TermInputSchema>;

export function termKeyOf(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, ' ');
}
