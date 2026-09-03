import type { Clock } from '../../../kernel/clock.js';
import type { Actor } from '../../../kernel/context.js';
import {
  type DomainError,
  ValidationError,
  validationErrorFromZod,
} from '../../../kernel/errors.js';
import { newUuid } from '../../../kernel/ids.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import type { Scope, TenantScope } from '../../../kernel/scope.js';
import type { TenantContext } from '../../../kernel/tenant.js';
import type { PolicyLevel } from '../../../kernel/action-policy.js';
import type { AuditRecorder } from '../../audit/index.js';
import {
  type CompanyProfile,
  type CompanyProfilePatch,
  CompanyProfilePatchSchema,
  CompanyProfileSchema,
  defaultCompanyProfile,
} from '../domain/company-profile.js';
import {
  type CompanyRule,
  CompanyRuleSchema,
  RuleKeySchema,
  type RuleRegistry,
} from '../domain/company-rule.js';
import {
  type PolicyOverride,
  PolicyOverrideSchema,
  type PolicySubjectKind,
} from '../domain/policy-override.js';
import {
  type Term,
  type TermInput,
  TermInputSchema,
  TermSchema,
  termKeyOf,
} from '../domain/terminology.js';
import type {
  CompanyProfileRepository,
  CompanyRuleRepository,
  PolicyOverrideRepository,
  TerminologyRepository,
} from './ports.js';

/**
 * The company context every AI System receives (ADR-0012 §1): profile,
 * current rule values and terminology. Structured and versioned — memory that
 * is governed, not a vector store (Direction §14).
 */
export interface CompanyContext {
  readonly profile: CompanyProfile;
  /** Current rule values by key; unset rules are absent. */
  readonly rules: Readonly<Record<string, unknown>>;
  readonly terminology: readonly Term[];
}

export interface WorkspaceConfigurationDependencies {
  readonly profiles: CompanyProfileRepository;
  readonly rules: CompanyRuleRepository;
  readonly terminology: TerminologyRepository;
  readonly policyOverrides: PolicyOverrideRepository;
  readonly ruleRegistry: RuleRegistry;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
}

const actorOf = (tenant: TenantContext): Actor => ({ type: 'USER', id: tenant.userId });

export class WorkspaceConfiguration {
  private readonly deps: WorkspaceConfigurationDependencies;

  constructor(deps: WorkspaceConfigurationDependencies) {
    this.deps = deps;
  }

  /** The context for a tenant. A tenant without a saved profile gets defaults derived from its name. */
  async context(scope: TenantScope, fallbackLegalName: string): Promise<CompanyContext> {
    const [profile, rules, terminology] = await Promise.all([
      this.deps.profiles.get(scope),
      this.deps.rules.current(scope),
      this.deps.terminology.list(scope),
    ]);
    const values: Record<string, unknown> = {};
    for (const rule of rules)
      if (rule.value !== null && rule.value !== undefined) values[rule.key] = rule.value;
    return {
      profile:
        profile ?? defaultCompanyProfile(scope.tenantId, fallbackLegalName, this.deps.clock.now()),
      rules: values,
      terminology,
    };
  }

  async updateProfile(
    scope: TenantScope,
    tenant: TenantContext,
    rawPatch: CompanyProfilePatch,
    fallbackLegalName: string,
  ): Promise<Result<CompanyProfile, DomainError>> {
    const patch = CompanyProfilePatchSchema.safeParse(rawPatch);
    if (!patch.success) {
      return err(
        validationErrorFromZod(patch.error, 'INVALID_PROFILE', 'The company profile is invalid.'),
      );
    }
    const current =
      (await this.deps.profiles.get(scope)) ??
      defaultCompanyProfile(scope.tenantId, fallbackLegalName, this.deps.clock.now());
    const next = CompanyProfileSchema.parse({
      ...current,
      ...stripUndefined(patch.data),
      version: current.version + 1,
      updatedAt: this.deps.clock.now(),
      updatedBy: tenant.userId,
    });
    const saved = await this.deps.profiles.upsert(scope, next);
    await this.deps.audit.record(scope, {
      organizationId: scope.tenantId,
      actor: actorOf(tenant),
      action: 'workspace.profile_updated',
      target: { type: 'company_profile', id: scope.tenantId },
      details: { version: saved.version, fields: Object.keys(stripUndefined(patch.data)) },
    });
    return ok(saved);
  }

  /** Sets (or unsets with `null`) a rule as a new version, after validating it against its definition. */
  async setRule(
    scope: TenantScope,
    tenant: TenantContext,
    key: string,
    value: unknown,
    rationale: string | null,
  ): Promise<Result<CompanyRule, DomainError>> {
    const parsedKey = RuleKeySchema.safeParse(key);
    if (!parsedKey.success) {
      return err(
        validationErrorFromZod(parsedKey.error, 'INVALID_RULE_KEY', 'The rule key is invalid.'),
      );
    }
    const definition = this.deps.ruleRegistry.get(parsedKey.data);
    if (definition === undefined) {
      return err(
        new ValidationError('UNKNOWN_RULE', `No rule "${parsedKey.data}" is defined.`, {
          details: { known: this.deps.ruleRegistry.list().map((d) => d.key) },
        }),
      );
    }
    if (value !== null) {
      const checked = definition.schema.safeParse(value);
      if (!checked.success) {
        return err(
          validationErrorFromZod(
            checked.error,
            'INVALID_RULE_VALUE',
            `The value for "${key}" is invalid.`,
          ),
        );
      }
      value = checked.data;
    }
    const history = await this.deps.rules.history(scope, parsedKey.data);
    const rule = CompanyRuleSchema.parse({
      id: newUuid(),
      organizationId: scope.tenantId,
      key: parsedKey.data,
      value,
      rationale,
      version: (history.at(-1)?.version ?? 0) + 1,
      createdAt: this.deps.clock.now(),
      createdBy: tenant.userId,
    });
    const saved = await this.deps.rules.append(scope, rule);
    await this.deps.audit.record(scope, {
      organizationId: scope.tenantId,
      actor: actorOf(tenant),
      action: value === null ? 'workspace.rule_unset' : 'workspace.rule_set',
      target: { type: 'company_rule', id: saved.key },
      details: { version: saved.version, value: saved.value, rationale },
    });
    return ok(saved);
  }

  async upsertTerm(
    scope: TenantScope,
    tenant: TenantContext,
    rawInput: TermInput,
  ): Promise<Result<Term, DomainError>> {
    const parsed = TermInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return err(validationErrorFromZod(parsed.error, 'INVALID_TERM', 'The term is invalid.'));
    }
    const existing = (await this.deps.terminology.list(scope, { includeInactive: true })).find(
      (term) => term.termKey === termKeyOf(parsed.data.term),
    );
    const now = this.deps.clock.now();
    const term = TermSchema.parse({
      id: existing?.id ?? newUuid(),
      organizationId: scope.tenantId,
      term: parsed.data.term,
      termKey: termKeyOf(parsed.data.term),
      meaning: parsed.data.meaning,
      examples: parsed.data.examples,
      active: parsed.data.active,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    const saved = await this.deps.terminology.upsert(scope, term);
    await this.deps.audit.record(scope, {
      organizationId: scope.tenantId,
      actor: actorOf(tenant),
      action: 'workspace.term_upserted',
      target: { type: 'term', id: saved.termKey },
      details: { active: saved.active },
    });
    return ok(saved);
  }

  async setPolicyOverride(
    scope: TenantScope,
    tenant: TenantContext,
    subjectKind: PolicySubjectKind,
    subject: string,
    level: PolicyLevel | null,
    rationale: string | null,
  ): Promise<Result<PolicyOverride, DomainError>> {
    const parsed = PolicyOverrideSchema.safeParse({
      organizationId: scope.tenantId,
      subjectKind,
      subject,
      level,
      rationale,
      updatedAt: this.deps.clock.now(),
      updatedBy: tenant.userId,
    });
    if (!parsed.success) {
      return err(
        validationErrorFromZod(
          parsed.error,
          'INVALID_POLICY_OVERRIDE',
          'The policy override is invalid.',
        ),
      );
    }
    const saved = await this.deps.policyOverrides.upsert(scope, parsed.data);
    await this.deps.audit.record(scope, {
      organizationId: scope.tenantId,
      actor: actorOf(tenant),
      action: level === null ? 'policy.override_cleared' : 'policy.override_set',
      target: { type: `policy_${subjectKind}`, id: subject },
      details: { level, rationale },
    });
    return ok(saved);
  }

  async policyOverrides(scope: Scope): Promise<PolicyOverride[]> {
    return this.deps.policyOverrides.list(scope);
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
