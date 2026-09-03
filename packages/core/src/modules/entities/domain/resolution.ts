import { z } from 'zod';

import {
  type Claim,
  EpistemicStatus,
  type Evidence,
  EvidenceKind,
} from '../../../kernel/epistemic.js';
import { type Determination, determined, nonDeterminato } from '../../../kernel/non-determinato.js';
import { type Entity, type EntityAliasKind, EntityAliasKindSchema } from './entity.js';

/**
 * The outcome of resolving a mention (an e-mail address, a name, a VAT number)
 * to an entity. Structured, so a system can explain it and the case engine
 * can turn ambiguity into NON_DETERMINATO instead of a guess.
 */
export const MatchReasonSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('alias'),
      aliasKind: EntityAliasKindSchema,
      value: z.string(),
      weight: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('name_similarity'),
      value: z.string(),
      similarity: z.number().min(0).max(1),
      weight: z.number().min(0).max(1),
    })
    .strict(),
]);
export type MatchReason = z.infer<typeof MatchReasonSchema>;

export interface EntityMatch {
  readonly entity: Entity;
  readonly reasons: readonly MatchReason[];
  /** Sum of reason weights, capped at 1. Ordinal, not a calibrated probability. */
  readonly score: number;
}

export type EntityResolution =
  | {
      readonly kind: 'RESOLVED';
      readonly match: EntityMatch;
      readonly others: readonly EntityMatch[];
    }
  | { readonly kind: 'AMBIGUOUS'; readonly candidates: readonly EntityMatch[] }
  | { readonly kind: 'UNRESOLVED' };

export const ALIAS_WEIGHTS: Readonly<Record<EntityAliasKind, number>> = {
  email: 1,
  vat: 1,
  code: 0.9,
  email_domain: 0.7,
  name: 0.6,
};

/** Evidence for a match: the record field that matched, citable later. */
export function evidenceForMatch(entity: Entity, reason: MatchReason): Evidence {
  return {
    kind: EvidenceKind.RECORD_FIELD,
    sourceRef: `entity:${entity.id}`,
    content: reason.value,
    locator:
      reason.kind === 'alias'
        ? { table: 'entity_aliases', field: reason.aliasKind }
        : { table: 'entities', field: 'name', similarity: reason.similarity },
  };
}

export function claimForMatch(match: EntityMatch): Claim {
  const status = match.reasons.some(
    (reason) =>
      reason.kind === 'alias' &&
      (reason.aliasKind === 'email' || reason.aliasKind === 'vat' || reason.aliasKind === 'code'),
  )
    ? EpistemicStatus.FACT
    : EpistemicStatus.ASSUMPTION;
  return {
    statement: `The counterpart is ${match.entity.name} (${match.entity.kind})`,
    status,
    evidence: match.reasons.map((reason) => evidenceForMatch(match.entity, reason)),
  };
}

/**
 * The resolution as a `Determination`: resolved becomes a value; ambiguity or
 * absence becomes an honest NON_DETERMINATO naming the candidates and the
 * missing input.
 */
export function resolutionToDetermination(
  resolution: EntityResolution,
  subject: string,
): Determination<EntityMatch> {
  if (resolution.kind === 'RESOLVED') return determined(resolution.match);
  const candidates = resolution.kind === 'AMBIGUOUS' ? resolution.candidates : [];
  const result = nonDeterminato({
    subject,
    known: candidates.map(claimForMatch),
    unknown:
      candidates.length > 0
        ? [`Which of ${candidates.length} candidate records the counterpart is`]
        : ['No known record matches the counterpart'],
    missingInputs: [
      {
        name: 'counterpart identity',
        description:
          candidates.length > 0
            ? 'Confirm which candidate is the counterpart, or record the sender as a new entity.'
            : 'Record the sender as a new entity or add an alias (e-mail, domain, VAT) to an existing one.',
        resolvableBy: 'HUMAN',
      },
    ],
  });
  if (!result.ok) throw result.error;
  return result.value;
}
