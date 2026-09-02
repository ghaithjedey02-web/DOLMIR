-- Platform foundation: helper schema, tenant-scope functions, append-only guard.
--
-- Prerequisites (created once, outside migrations — see supabase/bootstrap and
-- docs/deployment.md): roles `dolmir_owner` (runs this) and `dolmir_app`
-- (runtime, NOBYPASSRLS). Every later migration relies on these functions.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS dolmir;
GRANT USAGE ON SCHEMA dolmir TO dolmir_app;
GRANT USAGE ON SCHEMA public TO dolmir_app;

-- The tenant of the current transaction, set by the application with
-- set_config('dolmir.tenant_id', <uuid>, true). NULL when unset, so a
-- transaction without a tenant matches no row (ADR-0005).
CREATE OR REPLACE FUNCTION dolmir.current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('dolmir.tenant_id', true), '')::uuid
$$;

-- System scope: the explicit, logged path for operations without a tenant
-- (provisioning, cross-tenant listings for one user). Only the transaction
-- runner sets it.
CREATE OR REPLACE FUNCTION dolmir.is_system_scope() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('dolmir.scope', true), '') = 'system'
$$;

-- The predicate every tenant table uses in USING and WITH CHECK.
CREATE OR REPLACE FUNCTION dolmir.tenant_access(organization uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT dolmir.is_system_scope() OR organization = dolmir.current_tenant()
$$;

-- Append-only guard (ADR-0004): attached BEFORE UPDATE OR DELETE on ledger,
-- audit and usage tables. Raises for every role, owner included, so a
-- migration cannot rewrite history by accident either.
CREATE OR REPLACE FUNCTION dolmir.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only_violation: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '23000';
END
$$;

CREATE OR REPLACE FUNCTION dolmir.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- The migration ledger is created by the migrator before any migration runs;
-- the runtime role may read it for the readiness check.
GRANT SELECT ON TABLE public.schema_migrations TO dolmir_app;
