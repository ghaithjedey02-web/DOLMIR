import { z } from 'zod';

import { translatePgError } from '../../../../infrastructure/postgres/errors.js';
import { clientOf } from '../../../../infrastructure/postgres/transaction-runner.js';
import { InternalError, validationErrorFromZod } from '../../../../kernel/errors.js';
import { type DocumentId, DocumentIdSchema, OrganizationIdSchema } from '../../../../kernel/ids.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import { SourceKindSchema } from '../../../../kernel/source-kind.js';
import type {
  DocumentQuery,
  DocumentRepository,
  DocumentTextRepository,
} from '../../application/ports.js';
import {
  type Document,
  DocumentKindSchema,
  DocumentSchema,
  type NewDocument,
  type TextStatus,
  TextStatusSchema,
} from '../../domain/document.js';
import { type DocumentText, DocumentTextSchema } from '../../domain/document-text.js';

const DocumentRowSchema = z.object({
  id: DocumentIdSchema,
  organization_id: OrganizationIdSchema,
  kind: DocumentKindSchema,
  parent_id: DocumentIdSchema.nullable(),
  source_kind: SourceKindSchema,
  source_ref: z.string(),
  external_id: z.string().nullable(),
  object_key: z.string(),
  content_hash: z.string(),
  content_type: z.string(),
  filename: z.string().nullable(),
  size_bytes: z.number().int(),
  received_at: z.date(),
  metadata: z.record(z.string(), z.unknown()),
  text_status: TextStatusSchema,
  created_at: z.date(),
});

const TextRowSchema = z.object({
  document_id: DocumentIdSchema,
  part: z.number().int(),
  text: z.string(),
  char_count: z.number().int(),
  extractor: z.string(),
  extracted_at: z.date(),
});

const DOCUMENT_COLUMNS =
  'id, organization_id, kind, parent_id, source_kind, source_ref, external_id, object_key, content_hash, content_type, filename, size_bytes, received_at, metadata, text_status, created_at';

function toDocument(raw: unknown): Document {
  const parsed = DocumentRowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError('ROW_SHAPE_MISMATCH', 'A row of documents did not match its schema.', {
      cause: validationErrorFromZod(parsed.error),
    });
  }
  const row = parsed.data;
  return DocumentSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    kind: row.kind,
    parentId: row.parent_id,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    externalId: row.external_id,
    objectKey: row.object_key,
    contentHash: row.content_hash,
    contentType: row.content_type,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    receivedAt: row.received_at,
    metadata: row.metadata,
    textStatus: row.text_status,
    createdAt: row.created_at,
  });
}

function toText(raw: unknown): DocumentText {
  const parsed = TextRowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError(
      'ROW_SHAPE_MISMATCH',
      'A row of document_texts did not match its schema.',
      { cause: validationErrorFromZod(parsed.error) },
    );
  }
  const row = parsed.data;
  return DocumentTextSchema.parse({
    documentId: row.document_id,
    part: row.part,
    text: row.text,
    charCount: row.char_count,
    extractor: row.extractor,
    extractedAt: row.extracted_at,
  });
}

export class PostgresDocumentRepository implements DocumentRepository {
  async insert(scope: TenantScope, document: NewDocument): Promise<Document> {
    try {
      const result = await clientOf(scope).query(
        `INSERT INTO public.documents
           (id, organization_id, kind, parent_id, source_kind, source_ref, external_id, object_key,
            content_hash, content_type, filename, size_bytes, received_at, metadata, text_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
         RETURNING ${DOCUMENT_COLUMNS}`,
        [
          document.id,
          document.organizationId,
          document.kind,
          document.parentId,
          document.sourceKind,
          document.sourceRef,
          document.externalId,
          document.objectKey,
          document.contentHash,
          document.contentType,
          document.filename,
          document.sizeBytes,
          document.receivedAt,
          JSON.stringify(document.metadata),
          document.textStatus,
        ],
      );
      return toDocument(result.rows[0]);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async findById(scope: Scope, id: DocumentId): Promise<Document | undefined> {
    return this.one(scope, `SELECT ${DOCUMENT_COLUMNS} FROM public.documents WHERE id = $1`, [id]);
  }

  async findBySourceRef(scope: TenantScope, sourceRef: string): Promise<Document | undefined> {
    return this.one(
      scope,
      `SELECT ${DOCUMENT_COLUMNS} FROM public.documents WHERE organization_id = $1 AND source_ref = $2`,
      [scope.tenantId, sourceRef],
    );
  }

  async listChildren(scope: Scope, parentId: DocumentId): Promise<Document[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${DOCUMENT_COLUMNS} FROM public.documents WHERE parent_id = $1 ORDER BY created_at, id`,
        [parentId],
      );
      return result.rows.map((row: unknown) => toDocument(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async list(scope: TenantScope, query: DocumentQuery): Promise<Document[]> {
    const values: unknown[] = [scope.tenantId, Math.min(Math.max(query.limit, 1), 500)];
    const conditions = ['organization_id = $1'];
    if (query.before !== undefined) {
      values.push(query.before);
      conditions.push(`received_at < $${values.length}`);
    }
    if (query.kind !== undefined) {
      values.push(query.kind);
      conditions.push(`kind = $${values.length}`);
    }
    if (query.topLevelOnly === true) conditions.push('parent_id IS NULL');
    try {
      const result = await clientOf(scope).query(
        `SELECT ${DOCUMENT_COLUMNS} FROM public.documents
          WHERE ${conditions.join(' AND ')}
          ORDER BY received_at DESC, created_at DESC
          LIMIT $2`,
        values,
      );
      return result.rows.map((row: unknown) => toDocument(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async setTextStatus(scope: Scope, id: DocumentId, status: TextStatus): Promise<void> {
    try {
      await clientOf(scope).query('UPDATE public.documents SET text_status = $2 WHERE id = $1', [
        id,
        status,
      ]);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  private async one(scope: Scope, sql: string, values: unknown[]): Promise<Document | undefined> {
    try {
      const result = await clientOf(scope).query(sql, values);
      const row: unknown = result.rows[0];
      return row === undefined ? undefined : toDocument(row);
    } catch (error) {
      throw translatePgError(error);
    }
  }
}

export class PostgresDocumentTextRepository implements DocumentTextRepository {
  async replace(
    scope: Scope,
    documentId: DocumentId,
    texts: readonly DocumentText[],
  ): Promise<void> {
    try {
      const client = clientOf(scope);
      const organization = await client.query(
        'SELECT organization_id FROM public.documents WHERE id = $1',
        [documentId],
      );
      const first: unknown = organization.rows[0];
      const organizationId =
        typeof first === 'object' && first !== null
          ? (first as Record<string, unknown>)['organization_id']
          : undefined;
      if (typeof organizationId !== 'string') {
        throw new InternalError(
          'DOCUMENT_NOT_VISIBLE',
          'The document is not visible in this scope.',
        );
      }
      for (const text of texts) {
        await client.query(
          `INSERT INTO public.document_texts (organization_id, document_id, part, text, char_count, extractor, extracted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (document_id, part) DO UPDATE
             SET text = EXCLUDED.text, char_count = EXCLUDED.char_count,
                 extractor = EXCLUDED.extractor, extracted_at = EXCLUDED.extracted_at`,
          [
            organizationId,
            documentId,
            text.part,
            text.text,
            text.charCount,
            text.extractor,
            text.extractedAt,
          ],
        );
      }
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async listByDocument(scope: Scope, documentId: DocumentId): Promise<DocumentText[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT document_id, part, text, char_count, extractor, extracted_at
           FROM public.document_texts WHERE document_id = $1 ORDER BY part`,
        [documentId],
      );
      return result.rows.map((row: unknown) => toText(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }
}
