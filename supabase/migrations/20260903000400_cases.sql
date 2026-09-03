-- Cases (ADR-0012 §3): the attention engine's read model, derived from the
-- case/<id> ledger streams and applied in the same transaction. The record of
-- truth is the ledger (immutable by trigger); these tables can be rebuilt from
-- it, so the owner role may clear them while the runtime role can only insert
-- findings, approvals and actions and never deletes anything.

CREATE TABLE public.cases (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES public.organizations (id),
  system_key       text NOT NULL CHECK (system_key ~ '^[a-z][a-z0-9_]*$'),
  system_version   integer NOT NULL CHECK (system_version >= 1),
  kind             text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*$'),
  status           text NOT NULL CHECK (status IN ('open', 'awaiting_approval', 'resolved', 'dismissed')),
  priority         text NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  summary          text NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  determination    text NOT NULL CHECK (determination IN ('READY_FOR_REVIEW', 'NON_DETERMINATO', 'NOT_APPLICABLE')),
  non_determinato  jsonb,
  subjects         jsonb NOT NULL DEFAULT '[]'::jsonb,
  version          integer NOT NULL CHECK (version >= 1),
  opened_at        timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  resolved_at      timestamptz,
  resolution       text CHECK (resolution IS NULL OR length(resolution) BETWEEN 1 AND 100)
);

CREATE INDEX cases_org_status_idx ON public.cases (organization_id, status, opened_at DESC);
CREATE INDEX cases_org_system_idx ON public.cases (organization_id, system_key, opened_at DESC);
CREATE INDEX cases_subjects_idx ON public.cases USING gin (subjects jsonb_path_ops);

ALTER TABLE public.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cases FORCE ROW LEVEL SECURITY;
CREATE POLICY cases_tenant_access ON public.cases
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));
GRANT SELECT, INSERT, UPDATE ON public.cases TO dolmir_app;


CREATE TABLE public.case_findings (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES public.organizations (id),
  case_id          uuid NOT NULL REFERENCES public.cases (id),
  statement        text NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  status           text NOT NULL CHECK (status IN ('FACT', 'OBSERVATION', 'ASSUMPTION', 'HYPOTHESIS')),
  evidence         jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags             text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL
);

CREATE INDEX case_findings_case_idx ON public.case_findings (case_id);

ALTER TABLE public.case_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY case_findings_tenant_access ON public.case_findings
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));
GRANT SELECT, INSERT ON public.case_findings TO dolmir_app;


CREATE TABLE public.recommendations (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES public.organizations (id),
  case_id          uuid NOT NULL REFERENCES public.cases (id),
  tool             text NOT NULL CHECK (tool ~ '^[a-z][a-z0-9_]{1,63}$'),
  input            jsonb NOT NULL,
  input_hash       text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  rationale        text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 4000),
  level            text NOT NULL CHECK (level IN ('READ_ONLY', 'SUGGEST', 'DRAFT', 'REQUIRE_APPROVAL', 'AUTO_EXECUTE')),
  policy_version   integer NOT NULL CHECK (policy_version >= 0),
  status           text NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'executed', 'failed', 'superseded')),
  created_at       timestamptz NOT NULL,
  decided_at       timestamptz,
  decided_by       uuid REFERENCES public.users (id),
  decision_note    text CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 1 AND 2000),
  executed_at      timestamptz
);

CREATE INDEX recommendations_case_idx ON public.recommendations (case_id);
CREATE INDEX recommendations_org_status_idx ON public.recommendations (organization_id, status);

ALTER TABLE public.recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendations FORCE ROW LEVEL SECURITY;
CREATE POLICY recommendations_tenant_access ON public.recommendations
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));
GRANT SELECT, INSERT, UPDATE ON public.recommendations TO dolmir_app;


-- Human decisions: insert-only for the runtime role (no UPDATE grant); the
-- authoritative record is the RecommendationApproved/Rejected ledger event.
CREATE TABLE public.approvals (
  id                 uuid PRIMARY KEY,
  organization_id    uuid NOT NULL REFERENCES public.organizations (id),
  case_id            uuid NOT NULL REFERENCES public.cases (id),
  recommendation_id  uuid NOT NULL REFERENCES public.recommendations (id),
  decision           text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_by         uuid NOT NULL REFERENCES public.users (id),
  note               text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  decided_at         timestamptz NOT NULL
);

CREATE INDEX approvals_case_idx ON public.approvals (case_id);

ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY approvals_tenant_access ON public.approvals
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));
GRANT SELECT, INSERT ON public.approvals TO dolmir_app;


-- Executions: insert-only for the runtime role (no UPDATE grant); the
-- authoritative record is the ActionExecuted/ActionFailed ledger event.
CREATE TABLE public.actions (
  id                 uuid PRIMARY KEY,
  organization_id    uuid NOT NULL REFERENCES public.organizations (id),
  case_id            uuid NOT NULL REFERENCES public.cases (id),
  recommendation_id  uuid NOT NULL REFERENCES public.recommendations (id),
  tool               text NOT NULL,
  input_hash         text NOT NULL,
  status             text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  result             jsonb,
  error              jsonb,
  executed_at        timestamptz NOT NULL
);

CREATE INDEX actions_case_idx ON public.actions (case_id);

ALTER TABLE public.actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.actions FORCE ROW LEVEL SECURITY;
CREATE POLICY actions_tenant_access ON public.actions
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));
GRANT SELECT, INSERT ON public.actions TO dolmir_app;
