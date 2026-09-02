-- Tenancy: organizations (the tenants), users (global identities) and
-- memberships (who belongs where, with which role). Every table has
-- Row-Level Security enabled AND forced (ADR-0005).

CREATE TABLE public.organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE
              CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$'),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION dolmir.set_updated_at();

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY organizations_tenant_access ON public.organizations
  USING (dolmir.tenant_access(id))
  WITH CHECK (dolmir.tenant_access(id));

GRANT SELECT, INSERT, UPDATE ON public.organizations TO dolmir_app;


CREATE TABLE public.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The identity provider's stable subject (e.g. Supabase Auth user id).
  auth_subject  text NOT NULL UNIQUE,
  email         citext UNIQUE,
  display_name  text CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION dolmir.set_updated_at();

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON public.users TO dolmir_app;


CREATE TABLE public.memberships (
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  user_id         uuid NOT NULL REFERENCES public.users (id),
  -- Roles are defined in code (access module); the check keeps data honest.
  role_key        text NOT NULL CHECK (role_key IN ('owner', 'admin', 'operator', 'viewer')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX memberships_user_id_idx ON public.memberships (user_id);

CREATE TRIGGER memberships_set_updated_at
  BEFORE UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION dolmir.set_updated_at();

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY memberships_tenant_access ON public.memberships
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));

GRANT SELECT, INSERT, UPDATE ON public.memberships TO dolmir_app;


-- A tenant sees exactly the users who are members of the current organization.
-- Users are created in system scope only (just-in-time provisioning at login).
CREATE POLICY users_visible_to_their_tenants ON public.users
  FOR SELECT
  USING (
    dolmir.is_system_scope()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
       WHERE m.user_id = users.id
         AND m.organization_id = dolmir.current_tenant()
    )
  );

CREATE POLICY users_written_in_system_scope ON public.users
  FOR INSERT
  WITH CHECK (dolmir.is_system_scope());

CREATE POLICY users_updated_in_system_scope ON public.users
  FOR UPDATE
  USING (dolmir.is_system_scope())
  WITH CHECK (dolmir.is_system_scope());
