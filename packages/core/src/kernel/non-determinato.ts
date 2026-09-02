import { z } from 'zod';

import { ClaimSchema, EvidenceSchema, UncertaintySchema } from './epistemic.js';
import { validationErrorFromZod, type ValidationError } from './errors.js';
import { err, ok, type Result } from './result.js';

/**
 * NON_DETERMINATO — the honest outcome, as a first-class value (ADR-0007).
 *
 * When evidence is insufficient or contradictory DOLMIR does not guess. It
 * states what is known, what is unknown, which evidence exists and conflicts,
 * which inputs are missing and which human decision is required. This is a
 * legitimate, routable result — never an exception, never an empty answer.
 */

const nonEmpty = (message: string) => z.string().trim().min(1, message);

export const EvidenceConflictSchema = z
  .object({
    description: nonEmpty('EvidenceConflict.description must be non-empty.'),
    /** The two pieces of evidence that contradict each other. */
    evidence: z.tuple([EvidenceSchema, EvidenceSchema]),
  })
  .strict();
export type EvidenceConflict = z.infer<typeof EvidenceConflictSchema>;

export const MissingInputResolver = {
  HUMAN: 'HUMAN',
  SYSTEM: 'SYSTEM',
  EXTERNAL: 'EXTERNAL',
} as const;

export const MissingInputSchema = z
  .object({
    name: nonEmpty('MissingInput.name must be non-empty.'),
    description: nonEmpty('MissingInput.description must be non-empty.'),
    resolvableBy: z.enum(['HUMAN', 'SYSTEM', 'EXTERNAL']),
  })
  .strict();
export type MissingInput = z.infer<typeof MissingInputSchema>;

export const HumanDecisionRequestSchema = z
  .object({
    question: nonEmpty('HumanDecisionRequest.question must be non-empty.'),
    options: z
      .array(
        z
          .object({
            label: nonEmpty('Option.label must be non-empty.'),
            detail: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .default([]),
    /** What is at stake if the decision is wrong (money, delivery, relationship…). */
    stake: z.string().trim().min(1).optional(),
  })
  .strict();
export type HumanDecisionRequest = z.infer<typeof HumanDecisionRequestSchema>;

export const NonDeterminatoSchema = z
  .object({
    kind: z.literal('NON_DETERMINATO'),
    /** What was being determined (e.g. "quantity of line 2 of RFQ-2026-0521"). */
    subject: nonEmpty('NonDeterminato.subject must be non-empty.'),
    known: z.array(ClaimSchema).default([]),
    /** Named gaps in plain language. */
    unknown: z.array(nonEmpty('Unknown entries must be non-empty.')).default([]),
    evidence: z.array(EvidenceSchema).default([]),
    conflicts: z.array(EvidenceConflictSchema).default([]),
    missingInputs: z.array(MissingInputSchema).default([]),
    uncertainties: z.array(UncertaintySchema).default([]),
    requiredHumanDecision: HumanDecisionRequestSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.unknown.length === 0 &&
      value.conflicts.length === 0 &&
      value.missingInputs.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'NON_DETERMINATO must state at least one unknown, one evidence conflict or one missing input — otherwise the result is determinable.',
      });
    }
  });
export type NonDeterminato = z.infer<typeof NonDeterminatoSchema>;
export type NonDeterminatoInput = Omit<z.input<typeof NonDeterminatoSchema>, 'kind'>;

export function nonDeterminato(
  input: NonDeterminatoInput,
): Result<NonDeterminato, ValidationError> {
  const parsed = NonDeterminatoSchema.safeParse({ kind: 'NON_DETERMINATO', ...input });
  return parsed.success
    ? ok(parsed.data)
    : err(
        validationErrorFromZod(
          parsed.error,
          'INVALID_NON_DETERMINATO',
          'A NON_DETERMINATO result must explain what is missing.',
        ),
      );
}

export interface Determined<T> {
  readonly kind: 'DETERMINED';
  readonly value: T;
}

/** The outcome of any determination: a value, or an honest account of why there is none. */
export type Determination<T> = Determined<T> | NonDeterminato;

export function determined<T>(value: T): Determined<T> {
  return { kind: 'DETERMINED', value };
}

export function isDetermined<T>(determination: Determination<T>): determination is Determined<T> {
  return determination.kind === 'DETERMINED';
}

export function isNonDeterminato<T>(
  determination: Determination<T>,
): determination is NonDeterminato {
  return determination.kind === 'NON_DETERMINATO';
}
