import { ForbiddenError } from '../../../../kernel/errors.js';
import type { OrganizationId } from '../../../../kernel/ids.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import type {
  CompanyProfileRepository,
  CompanyRuleRepository,
  PolicyOverrideRepository,
  TerminologyRepository,
} from '../../application/ports.js';
import type { CompanyProfile } from '../../domain/company-profile.js';
import type { CompanyRule } from '../../domain/company-rule.js';
import type { PolicyOverride } from '../../domain/policy-override.js';
import type { Term } from '../../domain/terminology.js';

const visible = (scope: Scope, organizationId: OrganizationId): boolean =>
  scope.kind === 'system' || scope.tenantId === organizationId;

const refuse = (): never => {
  throw new ForbiddenError('DATABASE_ACCESS_DENIED', 'Row-level security refused the write.');
};

export class InMemoryWorkspaceStore {
  readonly profiles = new Map<OrganizationId, CompanyProfile>();
  readonly rules: CompanyRule[] = [];
  readonly terms: Term[] = [];
  readonly overrides: PolicyOverride[] = [];
}

export class InMemoryCompanyProfileRepository implements CompanyProfileRepository {
  private readonly store: InMemoryWorkspaceStore;

  constructor(store: InMemoryWorkspaceStore) {
    this.store = store;
  }

  async get(scope: Scope): Promise<CompanyProfile | undefined> {
    if (scope.kind === 'system') return undefined;
    return this.store.profiles.get(scope.tenantId);
  }

  async upsert(scope: TenantScope, profile: CompanyProfile): Promise<CompanyProfile> {
    if (profile.organizationId !== scope.tenantId) refuse();
    this.store.profiles.set(profile.organizationId, profile);
    return profile;
  }
}

export class InMemoryCompanyRuleRepository implements CompanyRuleRepository {
  private readonly store: InMemoryWorkspaceStore;

  constructor(store: InMemoryWorkspaceStore) {
    this.store = store;
  }

  async current(scope: Scope): Promise<CompanyRule[]> {
    const latest = new Map<string, CompanyRule>();
    for (const rule of this.store.rules) {
      if (!visible(scope, rule.organizationId)) continue;
      const key = `${rule.organizationId}:${rule.key}`;
      const existing = latest.get(key);
      if (existing === undefined || existing.version < rule.version) latest.set(key, rule);
    }
    return [...latest.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  async history(scope: Scope, key: string): Promise<CompanyRule[]> {
    return this.store.rules
      .filter((rule) => rule.key === key && visible(scope, rule.organizationId))
      .sort((a, b) => a.version - b.version);
  }

  async append(scope: TenantScope, rule: CompanyRule): Promise<CompanyRule> {
    if (rule.organizationId !== scope.tenantId) refuse();
    this.store.rules.push(rule);
    return rule;
  }
}

export class InMemoryTerminologyRepository implements TerminologyRepository {
  private readonly store: InMemoryWorkspaceStore;

  constructor(store: InMemoryWorkspaceStore) {
    this.store = store;
  }

  async list(scope: Scope, options: { readonly includeInactive?: boolean } = {}): Promise<Term[]> {
    return this.store.terms
      .filter((term) => visible(scope, term.organizationId))
      .filter((term) => options.includeInactive === true || term.active)
      .sort((a, b) => a.termKey.localeCompare(b.termKey));
  }

  async upsert(scope: TenantScope, term: Term): Promise<Term> {
    if (term.organizationId !== scope.tenantId) refuse();
    const index = this.store.terms.findIndex(
      (t) => t.organizationId === term.organizationId && t.termKey === term.termKey,
    );
    if (index >= 0) this.store.terms[index] = term;
    else this.store.terms.push(term);
    return term;
  }
}

export class InMemoryPolicyOverrideRepository implements PolicyOverrideRepository {
  private readonly store: InMemoryWorkspaceStore;

  constructor(store: InMemoryWorkspaceStore) {
    this.store = store;
  }

  async list(scope: Scope): Promise<PolicyOverride[]> {
    return this.store.overrides.filter((o) => visible(scope, o.organizationId));
  }

  async upsert(scope: TenantScope, override: PolicyOverride): Promise<PolicyOverride> {
    if (override.organizationId !== scope.tenantId) refuse();
    const index = this.store.overrides.findIndex(
      (o) =>
        o.organizationId === override.organizationId &&
        o.subjectKind === override.subjectKind &&
        o.subject === override.subject,
    );
    if (index >= 0) this.store.overrides[index] = override;
    else this.store.overrides.push(override);
    return override;
  }
}
