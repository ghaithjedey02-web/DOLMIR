-- Durable execution intent (P0: approved work must not depend on an HTTP
-- request staying alive).
--
-- One row per recommendation that the platform is entitled to execute. It is
-- written in the SAME transaction as the approval that authorises it — or, for
-- an AUTO_EXECUTE recommendation, as the case that proposes it — so
--
--     an approved recommendation ALWAYS has a durable execution intent
--
-- is a database fact rather than a hope about process lifetime. Nothing may
-- reach the outside world without one: the worker refuses a recommendation
-- whose intent row is missing.
--
-- The row is also the concurrency guard. A worker takes `SELECT … FOR UPDATE`
-- on it before doing anything, so a second worker blocks in PostgreSQL until
-- the first commits and then sees the terminal state. There is no application
-- flag to race, and the whole attempt — the external call and the outcome —
-- lives inside that one transaction.
--
-- `idempotency_key` is derived from the recommendation id and the approved
-- input hash, so every attempt carries the same outbound identity: the mail
-- adapter turns it into a stable Message-ID. Exactly-once delivery is still
-- not achievable across SMTP and PostgreSQL (see docs/demo.md); one identity
-- across attempts is the strongest guarantee the boundary allows.

-- It deliberately holds no foreign key to `recommendations` or `cases`. Those
-- are the read model, rebuildable from the ledger; this is operational truth
-- about what the platform was entitled to do and what it has already done, and
-- it must survive a rebuild. A rebuild that could drop the record of a sent
-- e-mail would licence sending it again.
CREATE TABLE public.action_intents (
  organization_id    uuid NOT NULL REFERENCES public.organizations (id),
  recommendation_id  uuid NOT NULL,
  case_id            uuid NOT NULL,
  tool               text NOT NULL CHECK (tool ~ '^[a-z][a-z0-9_]{1,63}$'),
  -- The approved input the intent authorises. An attempt whose recommendation
  -- no longer hashes to this is refused rather than executed.
  input_hash         text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key    text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  state              text NOT NULL CHECK (state IN ('pending', 'sent', 'failed')),
  -- Committed attempts. An attempt that crashed before commit is not counted,
  -- which is exactly the window that cannot be closed from this side.
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- What the provider called the message, once one attempt has committed.
  external_ref       text CHECK (external_ref IS NULL OR length(external_ref) BETWEEN 1 AND 500),
  last_error         text CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 2000),
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  PRIMARY KEY (organization_id, recommendation_id)
);

CREATE INDEX action_intents_pending_idx
  ON public.action_intents (organization_id, state, created_at)
  WHERE state <> 'sent';

ALTER TABLE public.action_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.action_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY action_intents_tenant_access ON public.action_intents
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));
GRANT SELECT, INSERT, UPDATE ON public.action_intents TO dolmir_app;
