import type { Scope, TenantScope } from '../../../kernel/scope.js';
import type { CompanyProfile } from '../domain/company-profile.js';
import type { CompanyRule } from '../domain/company-rule.js';
import type { PolicyOverride } from '../domain/policy-override.js';
import type { Term } from '../domain/terminology.js';

export interface CompanyProfileRepository {
  get(scope: Scope): Promise<CompanyProfile | undefined>;
  /** Inserts or replaces the tenant's single profile row. */
  upsert(scope: TenantScope, profile: CompanyProfile): Promise<CompanyProfile>;
}

export interface CompanyRuleRepository {
  /** The latest version of every key, unset rules included (value null). */
  current(scope: Scope): Promise<CompanyRule[]>;
  history(scope: Scope, key: string): Promise<CompanyRule[]>;
  /** Appends a version; the caller computes `version` as last + 1. */
  append(scope: TenantScope, rule: CompanyRule): Promise<CompanyRule>;
}

export interface TerminologyRepository {
  list(scope: Scope, options?: { readonly includeInactive?: boolean }): Promise<Term[]>;
  upsert(scope: TenantScope, term: Term): Promise<Term>;
}

export interface PolicyOverrideRepository {
  list(scope: Scope): Promise<PolicyOverride[]>;
  upsert(scope: TenantScope, override: PolicyOverride): Promise<PolicyOverride>;
}
