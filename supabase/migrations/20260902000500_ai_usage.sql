-- AI usage (Directive §19, plan §G/§O): one row per model call — successful,
-- failed or served from cache — priced by a versioned cost book. Append-only.

CREATE TABLE public.ai_usage (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL for platform-level calls (evaluations, diagnostics) made in system scope.
  organization_id    uuid REFERENCES public.organizations (id),
  provider           text NOT NULL CHECK (length(provider) BETWEEN 1 AND 50),
  model              text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  tier               text NOT NULL CHECK (tier IN ('fast', 'standard', 'deep')),
  operation          text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  use_case           text NOT NULL CHECK (use_case ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  input_tokens       integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens      integer NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens  integer NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens integer NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  -- USD, 8 decimals. Zero with priced = false means "unpriced model", not "free".
  estimated_cost     numeric(14, 8) NOT NULL CHECK (estimated_cost >= 0),
  currency           char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  pricing_version    integer NOT NULL CHECK (pricing_version >= 0),
  priced             boolean NOT NULL,
  latency_ms         integer NOT NULL CHECK (latency_ms >= 0),
  succeeded          boolean NOT NULL,
  error_kind         text CHECK (error_kind IS NULL OR length(error_kind) BETWEEN 1 AND 50),
  cached             boolean NOT NULL DEFAULT false,
  request_id         uuid,
  correlation_id     uuid,
  occurred_at        timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((error_kind IS NULL) = succeeded)
);

CREATE INDEX ai_usage_org_occurred_idx ON public.ai_usage (organization_id, occurred_at DESC);
CREATE INDEX ai_usage_org_use_case_idx ON public.ai_usage (organization_id, use_case, occurred_at DESC);

-- Append-only for every role, owner included (ADR-0004).
CREATE TRIGGER ai_usage_append_only
  BEFORE UPDATE OR DELETE ON public.ai_usage
  FOR EACH ROW EXECUTE FUNCTION dolmir.forbid_mutation();

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage FORCE ROW LEVEL SECURITY;

-- Tenant rows follow tenant access; platform-level rows are visible and
-- writable in system scope only (same shape as audit_log).
CREATE POLICY ai_usage_access ON public.ai_usage
  USING (
    CASE WHEN organization_id IS NULL THEN dolmir.is_system_scope()
         ELSE dolmir.tenant_access(organization_id) END
  )
  WITH CHECK (
    CASE WHEN organization_id IS NULL THEN dolmir.is_system_scope()
         ELSE dolmir.tenant_access(organization_id) END
  );

GRANT SELECT, INSERT ON public.ai_usage TO dolmir_app;
