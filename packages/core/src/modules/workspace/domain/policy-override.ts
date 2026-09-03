import { z } from 'zod';

import { OrganizationIdSchema, UserIdSchema } from '../../../kernel/ids.js';
import { PolicyLevelSchema, ToolEffectSchema } from '../../../kernel/action-policy.js';

/**
 * Company-specific action policy (ADR-0011 §2, §6): per tool or per effect.
 * A `null` level clears the override; the code default applies again.
 */
export const PolicySubjectKindSchema = z.enum(['tool', 'effect']);
export type PolicySubjectKind = z.infer<typeof PolicySubjectKindSchema>;

export const PolicyOverrideSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    subjectKind: PolicySubjectKindSchema,
    /** A tool name, or one of the effects. */
    subject: z.string().trim().min(1).max(100),
    level: PolicyLevelSchema.nullable(),
    rationale: z.string().trim().min(1).max(2000).nullable(),
    updatedAt: z.date(),
    updatedBy: UserIdSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.subjectKind === 'effect' && !ToolEffectSchema.safeParse(value.subject).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['subject'],
        message: 'an effect override must name read, analyze, draft or act',
      });
    }
  });
export type PolicyOverride = z.infer<typeof PolicyOverrideSchema>;
