-- Entities (ADR-0012, RESOLVE): the counterparts and things a company deals
-- with, and the aliases that identify them. Resolution is deterministic over
-- aliases; pg_trgm provides name similarity for weaker candidates.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE public.entities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations (id),
  kind             text NOT NULL CHECK (kind IN ('customer', 'supplier', 'contact', 'product')),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  code             text CHECK (code IS NULL OR length(code) BETWEEN 1 AND 100),
  attributes       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entities_org_kind_name_idx ON public.entities (organization_id, kind, name);

CREATE TRIGGER entities_set_updated_at
  BEFORE UPDATE ON public.entities
  FOR EACH ROW EXECUTE FUNCTION dolmir.set_updated_at();

ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entities FORCE ROW LEVEL SECURITY;
CREATE POLICY entities_tenant_access ON public.entities
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));

GRANT SELECT, INSERT, UPDATE ON public.entities TO dolmir_app;


CREATE TABLE public.entity_aliases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations (id),
  entity_id        uuid NOT NULL REFERENCES public.entities (id),
  kind             text NOT NULL CHECK (kind IN ('name', 'email', 'email_domain', 'vat', 'code')),
  -- Normalised form (see normaliseAliasValue); unique per tenant and kind.
  value            text NOT NULL CHECK (length(value) BETWEEN 1 AND 320),
  display          text NOT NULL CHECK (length(display) BETWEEN 1 AND 320),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_aliases_value_key UNIQUE (organization_id, kind, value)
);

CREATE INDEX entity_aliases_entity_idx ON public.entity_aliases (entity_id);
CREATE INDEX entity_aliases_name_trgm_idx ON public.entity_aliases USING gin (value gin_trgm_ops) WHERE kind = 'name';

ALTER TABLE public.entity_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY entity_aliases_tenant_access ON public.entity_aliases
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));

GRANT SELECT, INSERT ON public.entity_aliases TO dolmir_app;
