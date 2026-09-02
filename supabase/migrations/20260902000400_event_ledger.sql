-- Event ledger (ADR-0004): immutable business facts with provenance; current
-- state is projected from them. Append-only for every role.

CREATE TABLE public.ledger_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations (id),
  stream_type      text NOT NULL CHECK (stream_type ~ '^[a-z][a-z0-9_]*$'),
  stream_id        text NOT NULL CHECK (length(stream_id) BETWEEN 1 AND 255),
  stream_sequence  bigint NOT NULL CHECK (stream_sequence > 0),
  global_sequence  bigserial NOT NULL UNIQUE,
  event_type       text NOT NULL CHECK (event_type ~ '^[A-Z][A-Za-z0-9]*$'),
  schema_version   integer NOT NULL CHECK (schema_version >= 1),
  payload          jsonb NOT NULL,
  -- Mandatory provenance: where the fact came from, who recorded it, which evidence supports it.
  provenance       jsonb NOT NULL
                   CHECK (provenance ? 'sourceKind' AND provenance ? 'sourceRef'
                          AND provenance ? 'actor' AND provenance ? 'recordedBy'),
  occurred_at      timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  correlation_id   uuid,
  causation_id     uuid,
  idempotency_key  text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  CONSTRAINT ledger_events_stream_sequence_key UNIQUE (organization_id, stream_type, stream_id, stream_sequence)
);

CREATE UNIQUE INDEX ledger_events_idempotency_idx
  ON public.ledger_events (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX ledger_events_stream_idx ON public.ledger_events (organization_id, stream_type, stream_id);

CREATE TRIGGER ledger_events_append_only
  BEFORE UPDATE OR DELETE ON public.ledger_events
  FOR EACH ROW EXECUTE FUNCTION dolmir.forbid_mutation();

ALTER TABLE public.ledger_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_events FORCE ROW LEVEL SECURITY;

CREATE POLICY ledger_events_tenant_access ON public.ledger_events
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));

GRANT SELECT, INSERT ON public.ledger_events TO dolmir_app;
GRANT USAGE ON SEQUENCE public.ledger_events_global_sequence_seq TO dolmir_app;


-- Projection checkpoints: how far each read model has consumed the ledger.
-- Not tenant-scoped (a projection spans tenants and runs in system scope);
-- deliberately allow-listed in the SQL invariants test.
CREATE TABLE public.projection_checkpoints (
  projection_name       text PRIMARY KEY CHECK (projection_name ~ '^[a-z][a-z0-9_]*$'),
  last_global_sequence  bigint NOT NULL DEFAULT 0 CHECK (last_global_sequence >= 0),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.projection_checkpoints TO dolmir_app;
