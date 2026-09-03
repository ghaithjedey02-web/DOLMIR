-- Connectors (ADR-0013): one connection per tenant, capability and provider.
-- Credentials are an AES-256-GCM envelope produced by the connectors module
-- under DOLMIR_SECRETS_KEY with the tenant id as associated data; the database
-- never sees plaintext. The runtime role updates connections (status, cursor)
-- and never deletes them.

CREATE TABLE public.tenant_connections (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES public.organizations (id),
  capability       text NOT NULL CHECK (capability IN ('mailbox', 'ingest_endpoint')),
  provider         text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,49}$'),
  display_name     text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  credentials      jsonb NOT NULL,
  status           text NOT NULL CHECK (status IN ('active', 'disabled', 'error')),
  last_error       text CHECK (last_error IS NULL OR length(last_error) <= 2000),
  sync_state       jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at     timestamptz,
  version          integer NOT NULL CHECK (version >= 1),
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  CONSTRAINT tenant_connections_credentials_envelope CHECK (
    credentials ? 'v' AND credentials ? 'alg' AND credentials ? 'kid'
    AND credentials ? 'nonce' AND credentials ? 'ciphertext' AND credentials ? 'tag'
  )
);

CREATE INDEX tenant_connections_org_capability_idx
  ON public.tenant_connections (organization_id, capability, status);

ALTER TABLE public.tenant_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_connections_tenant_access ON public.tenant_connections
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));
GRANT SELECT, INSERT, UPDATE ON public.tenant_connections TO dolmir_app;


-- Replay protection for the signed ingestion endpoint: a nonce is claimed by
-- inserting it; a second claim conflicts. Rows expire logically; the owner
-- removes expired rows (operations task), the runtime role never deletes.
CREATE TABLE public.ingestion_nonces (
  organization_id  uuid NOT NULL REFERENCES public.organizations (id),
  key_id           text NOT NULL CHECK (key_id ~ '^ik_[a-f0-9]{16}$'),
  nonce            text NOT NULL CHECK (length(nonce) BETWEEN 16 AND 128),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (organization_id, key_id, nonce)
);

CREATE INDEX ingestion_nonces_expires_idx ON public.ingestion_nonces (expires_at);

ALTER TABLE public.ingestion_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingestion_nonces FORCE ROW LEVEL SECURITY;
CREATE POLICY ingestion_nonces_tenant_access ON public.ingestion_nonces
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));
GRANT SELECT, INSERT ON public.ingestion_nonces TO dolmir_app;
