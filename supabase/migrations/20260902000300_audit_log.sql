-- Audit log (Directive §7 K, §18): who did what to the system. Append-only.
-- Distinct from the event ledger (what happened in the business, ADR-0004).

CREATE TABLE public.audit_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL for platform-level events (no tenant yet, e.g. provisioning prelude).
  organization_id     uuid REFERENCES public.organizations (id),
  actor_type          text NOT NULL CHECK (actor_type IN ('USER', 'SERVICE', 'SYSTEM', 'AI')),
  actor_id            text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 255),
  actor_on_behalf_of  text,
  action              text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  target_type         text,
  target_id           text,
  outcome             text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  request_id          uuid,
  correlation_id      uuid,
  details             jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at         timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((target_type IS NULL) = (target_id IS NULL))
);

CREATE INDEX audit_log_org_occurred_idx ON public.audit_log (organization_id, occurred_at DESC);
CREATE INDEX audit_log_correlation_idx ON public.audit_log (correlation_id) WHERE correlation_id IS NOT NULL;

-- Append-only for every role, owner included (ADR-0004).
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION dolmir.forbid_mutation();

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;

-- Tenant entries follow tenant access; platform-level entries (no tenant)
-- are visible and writable in system scope only.
CREATE POLICY audit_log_access ON public.audit_log
  USING (
    CASE WHEN organization_id IS NULL THEN dolmir.is_system_scope()
         ELSE dolmir.tenant_access(organization_id) END
  )
  WITH CHECK (
    CASE WHEN organization_id IS NULL THEN dolmir.is_system_scope()
         ELSE dolmir.tenant_access(organization_id) END
  );

GRANT SELECT, INSERT ON public.audit_log TO dolmir_app;
