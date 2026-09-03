import { z } from 'zod';

import { ClaimSchema, EvidenceSchema, UncertaintySchema } from '../../../kernel/epistemic.js';
import {
  EvidenceConflictSchema,
  HumanDecisionRequestSchema,
  MissingInputSchema,
  NonDeterminatoSchema,
  nonDeterminato,
} from '../../../kernel/non-determinato.js';
import { Permission } from '../../../modules/access/index.js';
import { defineTool } from '../define-tool.js';
import { ToolEffect } from '../policy.js';

/**
 * The model's only honest way to say "this cannot be determined" (ADR-0007).
 * The kernel validates the declaration: at least one unknown, conflict or
 * missing input must be named, and every claim in `known` must satisfy the
 * grounding discipline. A vague declaration fails as INVALID_TOOL_INPUT
 * or INVALID_NON_DETERMINATO, never as an accepted answer.
 */
export const DeclareNonDeterminatoInputSchema = z
  .object({
    subject: z.string().trim().min(1),
    known: z.array(ClaimSchema).default([]),
    unknown: z.array(z.string().trim().min(1)).default([]),
    evidence: z.array(EvidenceSchema).default([]),
    conflicts: z.array(EvidenceConflictSchema).default([]),
    missingInputs: z.array(MissingInputSchema).default([]),
    uncertainties: z.array(UncertaintySchema).default([]),
    requiredHumanDecision: HumanDecisionRequestSchema.optional(),
  })
  .strict();
export type DeclareNonDeterminatoInput = z.infer<typeof DeclareNonDeterminatoInputSchema>;

export const DECLARE_NON_DETERMINATO = 'declare_non_determinato';

export const declareNonDeterminatoTool = defineTool({
  name: DECLARE_NON_DETERMINATO,
  description:
    'Declare that the subject cannot be determined from the available evidence. Use it instead of guessing whenever information is missing, sources conflict or a human must decide. State what is known (with evidence), what is unknown, which evidence conflicts, which inputs are missing and which human decision is required.',
  effect: ToolEffect.ANALYZE,
  permission: Permission.AI_INVOKE,
  input: DeclareNonDeterminatoInputSchema,
  output: NonDeterminatoSchema,
  handler: async (input) => nonDeterminato(input),
});
