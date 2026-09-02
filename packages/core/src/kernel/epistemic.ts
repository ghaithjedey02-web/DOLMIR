import { z } from 'zod';

import { validationErrorFromZod, type ValidationError } from './errors.js';
import { err, ok, type Result } from './result.js';

/**
 * Epistemic primitives (ADR-0007, Directive §10–§11).
 *
 * Every claim DOLMIR makes carries an explicit status, and the grounding
 * discipline is structural: a FACT without computation, citation or a typed
 * record read cannot be constructed; an OBSERVATION must point at the data it
 * read. Untraceable evidence is rejected at construction.
 */

export const EpistemicStatus = {
  /** Grounded in a deterministic computation, a cited source or a typed record. Not up for debate. */
  FACT: 'FACT',
  /** A direct, low-inference reading of input data. */
  OBSERVATION: 'OBSERVATION',
  /** An interpretation layered on observations — labelled, never silently promoted. */
  ASSUMPTION: 'ASSUMPTION',
  /** A forward-looking, inherently uncertain claim. */
  HYPOTHESIS: 'HYPOTHESIS',
} as const;
export const EpistemicStatusSchema = z.enum(['FACT', 'OBSERVATION', 'ASSUMPTION', 'HYPOTHESIS']);
export type EpistemicStatus = z.infer<typeof EpistemicStatusSchema>;

export const EvidenceKind = {
  /** A curated or external source, referenced by stable id and version. */
  CITATION: 'CITATION',
  /** Produced by a named deterministic computation over data in the system. */
  COMPUTATION: 'COMPUTATION',
  /** A typed read of a persisted record field (table, id, field). */
  RECORD_FIELD: 'RECORD_FIELD',
  /** A verbatim span of an ingested document (document id, offsets or page). */
  DOCUMENT_SPAN: 'DOCUMENT_SPAN',
  /** A direct reading of an input available to this run. */
  OBSERVATION: 'OBSERVATION',
} as const;
export const EvidenceKindSchema = z.enum([
  'CITATION',
  'COMPUTATION',
  'RECORD_FIELD',
  'DOCUMENT_SPAN',
  'OBSERVATION',
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

const nonEmpty = (message: string) => z.string().trim().min(1, message);

export const EvidenceSchema = z
  .object({
    kind: EvidenceKindSchema,
    /** Precise enough to audit later: document id + span, computation name + inputs, table/id/field, source id + version. */
    sourceRef: nonEmpty(
      'Evidence.sourceRef must be non-empty — untraceable evidence is not evidence.',
    ),
    /** The supporting content itself (a quote, a computed value rendered, a record value). */
    content: nonEmpty('Evidence.content must be non-empty.'),
    /** Optional machine-readable locator (offsets, page, row id, field name…). */
    locator: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  })
  .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

const FACT_GROUNDING: ReadonlySet<EvidenceKind> = new Set([
  EvidenceKind.CITATION,
  EvidenceKind.COMPUTATION,
  EvidenceKind.RECORD_FIELD,
]);
const OBSERVATION_GROUNDING: ReadonlySet<EvidenceKind> = new Set([
  EvidenceKind.OBSERVATION,
  EvidenceKind.DOCUMENT_SPAN,
  EvidenceKind.RECORD_FIELD,
]);

export const ClaimSchema = z
  .object({
    statement: nonEmpty('Claim.statement must be non-empty.'),
    status: EpistemicStatusSchema,
    evidence: z.array(EvidenceSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.status === EpistemicStatus.FACT &&
      !value.evidence.some((item) => FACT_GROUNDING.has(item.kind))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message:
          'A FACT requires at least one CITATION, COMPUTATION or RECORD_FIELD evidence; downgrade it to ASSUMPTION if no such grounding exists.',
      });
    }
    if (
      value.status === EpistemicStatus.OBSERVATION &&
      !value.evidence.some((item) => OBSERVATION_GROUNDING.has(item.kind))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message:
          'An OBSERVATION requires at least one OBSERVATION, DOCUMENT_SPAN or RECORD_FIELD evidence pointing at the data it read.',
      });
    }
  });
export type Claim = z.infer<typeof ClaimSchema>;
export type ClaimInput = z.input<typeof ClaimSchema>;

export function claim(input: ClaimInput): Result<Claim, ValidationError> {
  const parsed = ClaimSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err(
        validationErrorFromZod(
          parsed.error,
          'INVALID_CLAIM',
          'The claim violates the grounding discipline.',
        ),
      );
}

export const UncertaintyKind = {
  /** Reducible: a nameable input or check would resolve it. */
  MISSING_INFORMATION: 'MISSING_INFORMATION',
  /** Irreducible: the outcome is genuinely stochastic; more analysis will not resolve it. */
  STOCHASTIC: 'STOCHASTIC',
} as const;
export const UncertaintyKindSchema = z.enum(['MISSING_INFORMATION', 'STOCHASTIC']);
export type UncertaintyKind = z.infer<typeof UncertaintyKindSchema>;

export const UncertaintySchema = z
  .object({
    kind: UncertaintyKindSchema,
    description: nonEmpty('Uncertainty.description must be non-empty.'),
    /** What would resolve it. Required for MISSING_INFORMATION, forbidden for STOCHASTIC. */
    resolution: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === UncertaintyKind.MISSING_INFORMATION && value.resolution === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['resolution'],
        message: 'A MISSING_INFORMATION uncertainty must name what would resolve it.',
      });
    }
    if (value.kind === UncertaintyKind.STOCHASTIC && value.resolution !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['resolution'],
        message: 'A STOCHASTIC uncertainty is irreducible and cannot carry a resolution.',
      });
    }
  });
export type Uncertainty = z.infer<typeof UncertaintySchema>;
export type UncertaintyInput = z.input<typeof UncertaintySchema>;

export function uncertainty(input: UncertaintyInput): Result<Uncertainty, ValidationError> {
  const parsed = UncertaintySchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err(
        validationErrorFromZod(
          parsed.error,
          'INVALID_UNCERTAINTY',
          'The uncertainty violates the kind/resolution rules.',
        ),
      );
}
