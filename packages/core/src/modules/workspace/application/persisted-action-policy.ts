import type { OrganizationId } from '../../../kernel/ids.js';
import type { TransactionRunner } from '../../../kernel/scope.js';
import {
  ACTION_POLICY_VERSION,
  type ActionPolicy,
  DEFAULT_EFFECT_LEVELS,
  type PolicyResolution,
  type PolicySubject,
} from '../../../ai/index.js';
import type { PolicyOverrideRepository } from './ports.js';

/**
 * The persisted `ActionPolicy` (ADR-0011 §6): tenant overrides from the
 * database, resolved tool → effect → default. Reads happen in a short tenant
 * transaction of their own, so the executor can call it from anywhere.
 */
export class PersistedActionPolicy implements ActionPolicy {
  private readonly transactions: TransactionRunner;
  private readonly overrides: PolicyOverrideRepository;

  constructor(deps: {
    readonly transactions: TransactionRunner;
    readonly overrides: PolicyOverrideRepository;
  }) {
    this.transactions = deps.transactions;
    this.overrides = deps.overrides;
  }

  async resolve(tenantId: OrganizationId, subject: PolicySubject): Promise<PolicyResolution> {
    const overrides = await this.transactions.withTenant(tenantId, (scope) =>
      this.overrides.list(scope),
    );
    const byTool = overrides.find((o) => o.subjectKind === 'tool' && o.subject === subject.name);
    if (byTool !== undefined && byTool.level !== null) {
      return { level: byTool.level, version: ACTION_POLICY_VERSION, source: 'tenant_tool' };
    }
    const byEffect = overrides.find(
      (o) => o.subjectKind === 'effect' && o.subject === subject.effect,
    );
    if (byEffect !== undefined && byEffect.level !== null) {
      return { level: byEffect.level, version: ACTION_POLICY_VERSION, source: 'tenant_effect' };
    }
    return {
      level: DEFAULT_EFFECT_LEVELS[subject.effect],
      version: ACTION_POLICY_VERSION,
      source: 'default',
    };
  }
}
