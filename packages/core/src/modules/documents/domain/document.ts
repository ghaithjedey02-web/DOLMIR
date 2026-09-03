import { z } from 'zod';

import { DocumentIdSchema, OrganizationIdSchema } from '../../../kernel/ids.js';
import { ContentHashSchema, ObjectKeySchema } from '../../../kernel/object-storage.js';
import { SourceKindSchema } from '../../../kernel/source-kind.js';

/**
 * A document is any ingested artefact: an e-mail message, one of its
 * attachments, an uploaded file, a record export. It is the INGEST primitive
 * every AI System reads (ADR-0012). Bytes live in object storage under a
 * content-addressed key; text is extracted with stable offsets so evidence
 * can cite exact spans (`DOCUMENT_SPAN`).
 */
export const DocumentKind = {
  EMAIL: 'email',
  ATTACHMENT: 'attachment',
  FILE: 'file',
} as const;
export const DocumentKindSchema = z.enum(['email', 'attachment', 'file']);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

export const TextStatus = {
  PENDING: 'pending',
  EXTRACTED: 'extracted',
  UNSUPPORTED: 'unsupported',
  FAILED: 'failed',
} as const;
export const TextStatusSchema = z.enum(['pending', 'extracted', 'unsupported', 'failed']);
export type TextStatus = z.infer<typeof TextStatusSchema>;

const documentShape = {
  organizationId: OrganizationIdSchema,
  kind: DocumentKindSchema,
  /** The message an attachment belongs to; `null` for top-level documents. */
  parentId: DocumentIdSchema.nullable(),
  sourceKind: SourceKindSchema,
  /** Stable, unique per tenant: `imap:<account>:<uid>`, `ingest:<message-id>`, `upload:<hash>`. Makes ingestion idempotent. */
  sourceRef: z.string().trim().min(1).max(500),
  /** The source's own identifier when it has one (RFC 5322 Message-ID, ERP record id). */
  externalId: z.string().trim().min(1).max(500).nullable(),
  objectKey: ObjectKeySchema,
  contentHash: ContentHashSchema,
  contentType: z.string().trim().min(1).max(255),
  filename: z.string().trim().min(1).max(255).nullable(),
  sizeBytes: z.number().int().min(1),
  /** When the artefact arrived at its source (e-mail date, upload time). */
  receivedAt: z.date(),
  /** Source-specific facts (from, to, subject…). Never secrets. */
  metadata: z.record(z.string(), z.unknown()),
};

export const DocumentSchema = z
  .object({
    ...documentShape,
    id: DocumentIdSchema,
    textStatus: TextStatusSchema,
    createdAt: z.date(),
  })
  .strict();
export type Document = z.infer<typeof DocumentSchema>;

export const NewDocumentSchema = z
  .object({
    ...documentShape,
    id: DocumentIdSchema,
    parentId: DocumentIdSchema.nullable().default(null),
    externalId: z.string().trim().min(1).max(500).nullable().default(null),
    filename: z.string().trim().min(1).max(255).nullable().default(null),
    metadata: z.record(z.string(), z.unknown()).default({}),
    textStatus: TextStatusSchema.default('pending'),
  })
  .strict();
export type NewDocument = z.infer<typeof NewDocumentSchema>;
export type NewDocumentInput = z.input<typeof NewDocumentSchema>;
