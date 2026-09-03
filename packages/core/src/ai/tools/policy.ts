import { z } from 'zod';

import type { OrganizationId } from '../../kernel/ids.js';

/**
 * Action policy (ADR-0011, Direction §13). Every tool declares what kind of
 * effect it has; company policy decides how autonomously the AI may cause it.
 *
 *   read     returns data
 *   analyze  computes or classifies over data it was given
 *   draft    produces content a human may later send or apply; nothing outside DOLMIR changes
 *   act      changes the world or an approved record
 */
export const ToolEffect = {
  READ: 'read',
  ANALYZE: 'analyze',
  DRAFT: 'draft',
  ACT: 'act',
} as const;
export const ToolEffectSchema = z.enum(['read', 'analyze', 'draft', 'act']);
export type ToolEffect = z.infer<typeof ToolEffectSchema>;

export const PolicyLevel = {
  READ_ONLY: 'READ_ONLY',
  SUGGEST: 'SUGGEST',
  DRAFT: 'DRAFT',
  REQUIRE_APPROVAL: 'REQUIRE_APPROVAL',
  AUTO_EXECUTE: 'AUTO_EXECUTE',
} as const;
export const PolicyLevelSchema = z.enum([
  'READ_ONLY',
  'SUGGEST',
  'DRAFT',
  'REQUIRE_APPROVAL',
  'AUTO_EXECUTE',
]);
export type PolicyLevel = z.infer<typeof PolicyLevelSchema>;

/** Bumped whenever a default below changes; recorded in every audit entry. */
export const ACTION_POLICY_VERSION = 1;

/** The code-defined defaults. `act` requires a human approval; nothing auto-executes by default. */
export const DEFAULT_EFFECT_LEVELS: Readonly<Record<ToolEffect, PolicyLevel>> = {
  read: PolicyLevel.READ_ONLY,
  analyze: PolicyLevel.SUGGEST,
  draft: PolicyLevel.DRAFT,
  act: PolicyLevel.REQUIRE_APPROVAL,
};

export interface PolicySubject {
  readonly name: string;
  readonly effect: ToolEffect;
}

export interface PolicyResolution {
  readonly level: PolicyLevel;
  readonly version: number;
  readonly source: 'default' | 'tenant_effect' | 'tenant_tool';
}

export interface ActionPolicy {
  resolve(tenantId: OrganizationId, subject: PolicySubject): Promise<PolicyResolution>;
}

/**
 * Which levels may run a handler of a given effect. A level below the effect's
 * natural level means "the AI may only suggest this" — the tool does not run.
 * `REQUIRE_APPROVAL` runs only with a matching approval; the executor checks it.
 */
export function levelPermitsExecution(effect: ToolEffect, level: PolicyLevel): boolean {
  switch (effect) {
    case 'read':
    case 'analyze':
      return true;
    case 'draft':
      return level !== PolicyLevel.READ_ONLY && level !== PolicyLevel.SUGGEST;
    case 'act':
      return level === PolicyLevel.REQUIRE_APPROVAL || level === PolicyLevel.AUTO_EXECUTE;
  }
}

/** Code defaults only — what every tenant gets until an override exists. */
export class DefaultActionPolicy implements ActionPolicy {
  async resolve(_tenantId: OrganizationId, subject: PolicySubject): Promise<PolicyResolution> {
    return {
      level: DEFAULT_EFFECT_LEVELS[subject.effect],
      version: ACTION_POLICY_VERSION,
      source: 'default',
    };
  }
}

export interface TenantPolicyOverrides {
  readonly byTool?: Readonly<Record<string, PolicyLevel>>;
  readonly byEffect?: Readonly<Partial<Record<ToolEffect, PolicyLevel>>>;
}

/**
 * Per-tenant overrides held in memory: the interface the persisted
 * configuration table will implement when company-specific policy arrives
 * (Phase 2). Resolution order: tool override → effect override → default.
 */
export class InMemoryActionPolicy implements ActionPolicy {
  private readonly overrides = new Map<OrganizationId, TenantPolicyOverrides>();

  setOverrides(tenantId: OrganizationId, overrides: TenantPolicyOverrides): this {
    this.overrides.set(tenantId, overrides);
    return this;
  }

  async resolve(tenantId: OrganizationId, subject: PolicySubject): Promise<PolicyResolution> {
    const tenant = this.overrides.get(tenantId);
    const byTool = tenant?.byTool?.[subject.name];
    if (byTool !== undefined) {
      return { level: byTool, version: ACTION_POLICY_VERSION, source: 'tenant_tool' };
    }
    const byEffect = tenant?.byEffect?.[subject.effect];
    if (byEffect !== undefined) {
      return { level: byEffect, version: ACTION_POLICY_VERSION, source: 'tenant_effect' };
    }
    return {
      level: DEFAULT_EFFECT_LEVELS[subject.effect],
      version: ACTION_POLICY_VERSION,
      source: 'default',
    };
  }
}
