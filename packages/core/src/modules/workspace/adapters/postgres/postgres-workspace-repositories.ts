import { z } from 'zod';

import { translatePgError } from '../../../../infrastructure/postgres/errors.js';
import { clientOf } from '../../../../infrastructure/postgres/transaction-runner.js';
import { InternalError, validationErrorFromZod } from '../../../../kernel/errors.js';
import { OrganizationIdSchema, UserIdSchema, UuidSchema } from '../../../../kernel/ids.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import { PolicyLevelSchema } from '../../../../kernel/action-policy.js';
import type {
  CompanyProfileRepository,
  CompanyRuleRepository,
  PolicyOverrideRepository,
  TerminologyRepository,
} from '../../application/ports.js';
import { type CompanyProfile, CompanyProfileSchema } from '../../domain/company-profile.js';
import { type CompanyRule, CompanyRuleSchema } from '../../domain/company-rule.js';
import {
  type PolicyOverride,
  PolicyOverrideSchema,
  PolicySubjectKindSchema,
} from '../../domain/policy-override.js';
import { type Term, TermSchema } from '../../domain/terminology.js';

function parseRow<S extends z.ZodType>(schema: S, raw: unknown, table: string): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError('ROW_SHAPE_MISMATCH', `A row of ${table} did not match its schema.`, {
      cause: validationErrorFromZod(parsed.error),
    });
  }
  return parsed.data;
}

const ProfileRow = z.object({
  organization_id: OrganizationIdSchema,
  legal_name: z.string(),
  sector: z.string().nullable(),
  description: z.string().nullable(),
  languages: z.array(z.string()),
  timezone: z.string(),
  signature: z.string().nullable(),
  version: z.number().int(),
  updated_at: z.date(),
  updated_by: UserIdSchema.nullable(),
});

const RuleRow = z.object({
  id: UuidSchema,
  organization_id: OrganizationIdSchema,
  key: z.string(),
  value: z.unknown(),
  rationale: z.string().nullable(),
  version: z.number().int(),
  created_at: z.date(),
  created_by: UserIdSchema.nullable(),
});

const TermRow = z.object({
  id: UuidSchema,
  organization_id: OrganizationIdSchema,
  term: z.string(),
  term_key: z.string(),
  meaning: z.string(),
  examples: z.array(z.string()),
  active: z.boolean(),
  created_at: z.date(),
  updated_at: z.date(),
});

const OverrideRow = z.object({
  organization_id: OrganizationIdSchema,
  subject_kind: PolicySubjectKindSchema,
  subject: z.string(),
  level: PolicyLevelSchema.nullable(),
  rationale: z.string().nullable(),
  updated_at: z.date(),
  updated_by: UserIdSchema.nullable(),
});

const PROFILE_COLUMNS =
  'organization_id, legal_name, sector, description, languages, timezone, signature, version, updated_at, updated_by';
const RULE_COLUMNS = 'id, organization_id, key, value, rationale, version, created_at, created_by';
const TERM_COLUMNS =
  'id, organization_id, term, term_key, meaning, examples, active, created_at, updated_at';
const OVERRIDE_COLUMNS =
  'organization_id, subject_kind, subject, level, rationale, updated_at, updated_by';

const toProfile = (raw: unknown): CompanyProfile => {
  const row = parseRow(ProfileRow, raw, 'company_profiles');
  return CompanyProfileSchema.parse({
    organizationId: row.organization_id,
    legalName: row.legal_name,
    sector: row.sector,
    description: row.description,
    languages: row.languages,
    timezone: row.timezone,
    signature: row.signature,
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  });
};

const toRule = (raw: unknown): CompanyRule => {
  const row = parseRow(RuleRow, raw, 'company_rules');
  return CompanyRuleSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    key: row.key,
    value: row.value ?? null,
    rationale: row.rationale,
    version: row.version,
    createdAt: row.created_at,
    createdBy: row.created_by,
  });
};

const toTerm = (raw: unknown): Term => {
  const row = parseRow(TermRow, raw, 'terminology');
  return TermSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    term: row.term,
    termKey: row.term_key,
    meaning: row.meaning,
    examples: row.examples,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
};

const toOverride = (raw: unknown): PolicyOverride => {
  const row = parseRow(OverrideRow, raw, 'policy_overrides');
  return PolicyOverrideSchema.parse({
    organizationId: row.organization_id,
    subjectKind: row.subject_kind,
    subject: row.subject,
    level: row.level,
    rationale: row.rationale,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  });
};

export class PostgresCompanyProfileRepository implements CompanyProfileRepository {
  async get(scope: Scope): Promise<CompanyProfile | undefined> {
    if (scope.kind === 'system') return undefined;
    try {
      const result = await clientOf(scope).query(
        `SELECT ${PROFILE_COLUMNS} FROM public.company_profiles WHERE organization_id = $1`,
        [scope.tenantId],
      );
      const row: unknown = result.rows[0];
      return row === undefined ? undefined : toProfile(row);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async upsert(scope: TenantScope, profile: CompanyProfile): Promise<CompanyProfile> {
    try {
      const result = await clientOf(scope).query(
        `INSERT INTO public.company_profiles
           (organization_id, legal_name, sector, description, languages, timezone, signature, version, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10)
         ON CONFLICT (organization_id) DO UPDATE SET
           legal_name = EXCLUDED.legal_name, sector = EXCLUDED.sector, description = EXCLUDED.description,
           languages = EXCLUDED.languages, timezone = EXCLUDED.timezone, signature = EXCLUDED.signature,
           version = EXCLUDED.version, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
         RETURNING ${PROFILE_COLUMNS}`,
        [
          profile.organizationId,
          profile.legalName,
          profile.sector,
          profile.description,
          profile.languages,
          profile.timezone,
          profile.signature,
          profile.version,
          profile.updatedAt,
          profile.updatedBy,
        ],
      );
      return toProfile(result.rows[0]);
    } catch (error) {
      throw translatePgError(error);
    }
  }
}

export class PostgresCompanyRuleRepository implements CompanyRuleRepository {
  async current(scope: Scope): Promise<CompanyRule[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT DISTINCT ON (organization_id, key) ${RULE_COLUMNS}
           FROM public.company_rules
          ORDER BY organization_id, key, version DESC`,
      );
      return result.rows.map((row: unknown) => toRule(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async history(scope: Scope, key: string): Promise<CompanyRule[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${RULE_COLUMNS} FROM public.company_rules WHERE key = $1 ORDER BY version`,
        [key],
      );
      return result.rows.map((row: unknown) => toRule(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async append(scope: TenantScope, rule: CompanyRule): Promise<CompanyRule> {
    try {
      const result = await clientOf(scope).query(
        `INSERT INTO public.company_rules (id, organization_id, key, value, rationale, version, created_at, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8) RETURNING ${RULE_COLUMNS}`,
        [
          rule.id,
          rule.organizationId,
          rule.key,
          JSON.stringify(rule.value ?? null),
          rule.rationale,
          rule.version,
          rule.createdAt,
          rule.createdBy,
        ],
      );
      return toRule(result.rows[0]);
    } catch (error) {
      throw translatePgError(error);
    }
  }
}

export class PostgresTerminologyRepository implements TerminologyRepository {
  async list(scope: Scope, options: { readonly includeInactive?: boolean } = {}): Promise<Term[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${TERM_COLUMNS} FROM public.terminology
          WHERE ($1::boolean OR active) ORDER BY term_key`,
        [options.includeInactive === true],
      );
      return result.rows.map((row: unknown) => toTerm(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async upsert(scope: TenantScope, term: Term): Promise<Term> {
    try {
      const result = await clientOf(scope).query(
        `INSERT INTO public.terminology (id, organization_id, term, term_key, meaning, examples, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9)
         ON CONFLICT (organization_id, term_key) DO UPDATE SET
           term = EXCLUDED.term, meaning = EXCLUDED.meaning, examples = EXCLUDED.examples,
           active = EXCLUDED.active, updated_at = EXCLUDED.updated_at
         RETURNING ${TERM_COLUMNS}`,
        [
          term.id,
          term.organizationId,
          term.term,
          term.termKey,
          term.meaning,
          term.examples,
          term.active,
          term.createdAt,
          term.updatedAt,
        ],
      );
      return toTerm(result.rows[0]);
    } catch (error) {
      throw translatePgError(error);
    }
  }
}

export class PostgresPolicyOverrideRepository implements PolicyOverrideRepository {
  async list(scope: Scope): Promise<PolicyOverride[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${OVERRIDE_COLUMNS} FROM public.policy_overrides ORDER BY subject_kind, subject`,
      );
      return result.rows.map((row: unknown) => toOverride(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async upsert(scope: TenantScope, override: PolicyOverride): Promise<PolicyOverride> {
    try {
      const result = await clientOf(scope).query(
        `INSERT INTO public.policy_overrides (organization_id, subject_kind, subject, level, rationale, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (organization_id, subject_kind, subject) DO UPDATE SET
           level = EXCLUDED.level, rationale = EXCLUDED.rationale,
           updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
         RETURNING ${OVERRIDE_COLUMNS}`,
        [
          override.organizationId,
          override.subjectKind,
          override.subject,
          override.level,
          override.rationale,
          override.updatedAt,
          override.updatedBy,
        ],
      );
      return toOverride(result.rows[0]);
    } catch (error) {
      throw translatePgError(error);
    }
  }
}
