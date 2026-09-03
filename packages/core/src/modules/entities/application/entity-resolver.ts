import type { EntityId } from '../../../kernel/ids.js';
import type { TenantScope } from '../../../kernel/scope.js';
import {
  type Entity,
  type EntityAliasKind,
  type EntityKind,
  emailDomain,
  isPublicEmailDomain,
  normaliseAliasValue,
} from '../domain/entity.js';
import {
  ALIAS_WEIGHTS,
  type EntityMatch,
  type EntityResolution,
  type MatchReason,
} from '../domain/resolution.js';
import type { EntityAliasRepository, EntityRepository } from './ports.js';

/**
 * Deterministic entity resolution (RESOLVE stage). Exact aliases first —
 * e-mail, VAT number, code, then the e-mail domain (never a public mailbox
 * provider) and the normalised name — then trigram similarity on names as a
 * weaker signal. One clear winner resolves; near ties are AMBIGUOUS; nothing
 * is UNRESOLVED. No model is involved, so the answer is explainable and stable.
 */
export interface ResolveEntityInput {
  readonly kind: EntityKind;
  readonly email?: string;
  readonly name?: string;
  readonly vat?: string;
  readonly code?: string;
}

export interface EntityResolverOptions {
  /** Minimum score of the best candidate to call it resolved. */
  readonly resolveThreshold?: number;
  /** Minimum gap between the best and the second candidate. */
  readonly ambiguityGap?: number;
  /** Minimum trigram similarity for a name to count as a candidate. */
  readonly similarityFloor?: number;
}

export class EntityResolver {
  private readonly entities: EntityRepository;
  private readonly aliases: EntityAliasRepository;
  private readonly resolveThreshold: number;
  private readonly ambiguityGap: number;
  private readonly similarityFloor: number;

  constructor(
    deps: { readonly entities: EntityRepository; readonly aliases: EntityAliasRepository },
    options: EntityResolverOptions = {},
  ) {
    this.entities = deps.entities;
    this.aliases = deps.aliases;
    this.resolveThreshold = options.resolveThreshold ?? 0.7;
    this.ambiguityGap = options.ambiguityGap ?? 0.3;
    this.similarityFloor = options.similarityFloor ?? 0.55;
  }

  async resolve(scope: TenantScope, input: ResolveEntityInput): Promise<EntityResolution> {
    const reasons = new Map<EntityId, MatchReason[]>();
    const addReason = (entityId: EntityId, reason: MatchReason): void => {
      const list = reasons.get(entityId) ?? [];
      list.push(reason);
      reasons.set(entityId, list);
    };

    const exact: { kind: EntityAliasKind; raw: string | undefined }[] = [
      { kind: 'email', raw: input.email },
      { kind: 'vat', raw: input.vat },
      { kind: 'code', raw: input.code },
      { kind: 'name', raw: input.name },
    ];
    const domain = input.email === undefined ? undefined : emailDomain(input.email);
    if (domain !== undefined && !isPublicEmailDomain(domain)) {
      exact.push({ kind: 'email_domain', raw: domain });
    }
    for (const { kind, raw } of exact) {
      if (raw === undefined || raw.trim().length === 0) continue;
      const value = normaliseAliasValue(kind, raw);
      if (value.length === 0) continue;
      const matches = await this.aliases.findByValue(scope, kind, value);
      for (const alias of matches) {
        addReason(alias.entityId, {
          kind: 'alias',
          aliasKind: kind,
          value: alias.display,
          weight: ALIAS_WEIGHTS[kind],
        });
      }
    }

    if (input.name !== undefined && input.name.trim().length > 0) {
      const key = normaliseAliasValue('name', input.name);
      if (key.length > 0) {
        const similar = await this.aliases.similarNames(scope, input.kind, key, 5);
        for (const candidate of similar) {
          if (candidate.similarity < this.similarityFloor) continue;
          const already =
            reasons
              .get(candidate.entityId)
              ?.some((r) => r.kind === 'alias' && r.aliasKind === 'name') ?? false;
          if (already) continue;
          addReason(candidate.entityId, {
            kind: 'name_similarity',
            value: candidate.value,
            similarity: candidate.similarity,
            weight: Math.round(candidate.similarity * 0.5 * 100) / 100,
          });
        }
      }
    }

    if (reasons.size === 0) return { kind: 'UNRESOLVED' };

    const entities = await this.entities.findByIds(scope, [...reasons.keys()]);
    const byId = new Map(entities.map((entity) => [entity.id, entity]));
    const matches: EntityMatch[] = [];
    for (const [entityId, entityReasons] of reasons) {
      const entity = byId.get(entityId);
      if (entity?.kind !== input.kind || entity.status !== 'active') continue;
      const score = Math.min(
        1,
        entityReasons.reduce((sum, reason) => sum + reason.weight, 0),
      );
      matches.push({ entity, reasons: entityReasons, score: Math.round(score * 100) / 100 });
    }
    matches.sort((a, b) => b.score - a.score || a.entity.name.localeCompare(b.entity.name));

    const [best, second] = matches;
    if (best === undefined) return { kind: 'UNRESOLVED' };
    const clearWinner =
      best.score >= this.resolveThreshold &&
      (second === undefined || best.score - second.score >= this.ambiguityGap);
    if (clearWinner) return { kind: 'RESOLVED', match: best, others: matches.slice(1) };
    return { kind: 'AMBIGUOUS', candidates: matches };
  }
}

export type { Entity };
