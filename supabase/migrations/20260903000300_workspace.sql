-- Workspace configuration (Direction §13–§14, ADR-0011): the company's
-- profile, its versioned rules, its terminology and its action-policy
-- overrides. Structured, governed, per tenant.

CREATE TABLE public.company_profiles (
  organization_id  uuid PRIMARY KEY REFERENCES public.organizations (id),
  legal_name       text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 300),
  sector           text CHECK (sector IS NULL OR length(sector) BETWEEN 1 AND 200),
  description      text CHECK (description IS NULL OR length(description) BETWEEN 1 AND 4000),
  languages        text[] NOT NULL CHECK (array_length(languages, 1) BETWEEN 1 AND 10),
  timezone         text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  signature        text CHECK (signature IS NULL OR length(signature) BETWEEN 1 AND 2000),
  version          integer NOT NULL CHECK (version >= 1),
  updated_at       timestamptz NOT NULL,
  updated_by       uuid REFERENCES public.users (id)
);

ALTER TABLE public.company_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY company_profiles_tenant_access ON public.company_profiles
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));
GRANT SELECT, INSERT, UPDATE ON public.company_profiles TO dolmir_app;


-- Every rule change is a new version row: the history is the governance record.
CREATE TABLE public.company_rules (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES public.organizations (id),
  key              text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  -- NULL (JSON null) unsets the rule.
  value            jsonb NOT NULL,
  rationale        text CHECK (rationale IS NULL OR length(rationale) BETWEEN 1 AND 2000),
  version          integer NOT NULL CHECK (version >= 1),
  created_at       timestamptz NOT NULL,
  created_by       uuid REFERENCES public.users (id),
  CONSTRAINT company_rules_version_key UNIQUE (organization_id, key, version)
);

CREATE TRIGGER company_rules_append_only
  BEFORE UPDATE OR DELETE ON public.company_rules
  FOR EACH ROW EXECUTE FUNCTION dolmir.forbid_mutation();

ALTER TABLE public.company_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY company_rules_tenant_access ON public.company_rules
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));
GRANT SELECT, INSERT ON public.company_rules TO dolmir_app;


CREATE TABLE public.terminology (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES public.organizations (id),
  term             text NOT NULL CHECK (length(term) BETWEEN 1 AND 100),
  term_key         text NOT NULL CHECK (length(term_key) BETWEEN 1 AND 100),
  meaning          text NOT NULL CHECK (length(meaning) BETWEEN 1 AND 2000),
  examples         text[] NOT NULL DEFAULT '{}',
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  CONSTRAINT terminology_term_key UNIQUE (organization_id, term_key)
);

ALTER TABLE public.terminology ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.terminology FORCE ROW LEVEL SECURITY;
CREATE POLICY terminology_tenant_access ON public.terminology
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));
GRANT SELECT, INSERT, UPDATE ON public.terminology TO dolmir_app;


-- Action policy overrides (ADR-0011): per tool or per effect; NULL level = cleared.
CREATE TABLE public.policy_overrides (
  organization_id  uuid NOT NULL REFERENCES public.organizations (id),
  subject_kind     text NOT NULL CHECK (subject_kind IN ('tool', 'effect')),
  subject          text NOT NULL CHECK (length(subject) BETWEEN 1 AND 100),
  level            text CHECK (level IS NULL OR level IN ('READ_ONLY', 'SUGGEST', 'DRAFT', 'REQUIRE_APPROVAL', 'AUTO_EXECUTE')),
  rationale        text CHECK (rationale IS NULL OR length(rationale) BETWEEN 1 AND 2000),
  updated_at       timestamptz NOT NULL,
  updated_by       uuid REFERENCES public.users (id),
  PRIMARY KEY (organization_id, subject_kind, subject)
);

ALTER TABLE public.policy_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policy_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY policy_overrides_tenant_access ON public.policy_overrides
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));
GRANT SELECT, INSERT, UPDATE ON public.policy_overrides TO dolmir_app;
