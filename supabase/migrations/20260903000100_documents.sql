-- Documents (ADR-0012, INGEST): any ingested artefact, content-addressed in
-- object storage, with extracted text kept at stable offsets so evidence can
-- cite exact spans. Idempotent on (organization_id, source_ref).

CREATE TABLE public.documents (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES public.organizations (id),
  kind             text NOT NULL CHECK (kind IN ('email', 'attachment', 'file')),
  parent_id        uuid REFERENCES public.documents (id),
  source_kind      text NOT NULL CHECK (source_kind IN ('DOCUMENT', 'EMAIL', 'ERP', 'USER', 'SYSTEM', 'AI', 'INTEGRATION')),
  source_ref       text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 500),
  external_id      text CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 500),
  object_key       text NOT NULL,
  content_hash     text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  content_type     text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  filename         text CHECK (filename IS NULL OR length(filename) BETWEEN 1 AND 255),
  size_bytes       integer NOT NULL CHECK (size_bytes > 0),
  received_at      timestamptz NOT NULL,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  text_status      text NOT NULL DEFAULT 'pending' CHECK (text_status IN ('pending', 'extracted', 'unsupported', 'failed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_source_ref_key UNIQUE (organization_id, source_ref)
);

CREATE INDEX documents_org_received_idx ON public.documents (organization_id, received_at DESC);
CREATE INDEX documents_parent_idx ON public.documents (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX documents_org_hash_idx ON public.documents (organization_id, content_hash);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_tenant_access ON public.documents
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));

-- text_status is the only mutable column.
GRANT SELECT, INSERT, UPDATE (text_status) ON public.documents TO dolmir_app;


CREATE TABLE public.document_texts (
  organization_id  uuid NOT NULL REFERENCES public.organizations (id),
  document_id      uuid NOT NULL REFERENCES public.documents (id),
  part             integer NOT NULL CHECK (part >= 0),
  text             text NOT NULL,
  char_count       integer NOT NULL CHECK (char_count >= 0),
  extractor        text NOT NULL CHECK (length(extractor) BETWEEN 1 AND 50),
  extracted_at     timestamptz NOT NULL,
  PRIMARY KEY (document_id, part)
);

ALTER TABLE public.document_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_texts FORCE ROW LEVEL SECURITY;
CREATE POLICY document_texts_tenant_access ON public.document_texts
  USING (dolmir.tenant_access(organization_id))
  WITH CHECK (dolmir.tenant_access(organization_id));

-- Re-extraction upserts; there is no DELETE for the runtime role.
GRANT SELECT, INSERT, UPDATE ON public.document_texts TO dolmir_app;
