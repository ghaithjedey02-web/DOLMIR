import { z } from 'zod';

import type { Clock } from '../../../kernel/clock.js';
import { ActorSchema } from '../../../kernel/context.js';
import {
  ConflictError,
  type DomainError,
  isDomainError,
  validationErrorFromZod,
} from '../../../kernel/errors.js';
import { newDocumentId, DocumentIdSchema, OrganizationIdSchema } from '../../../kernel/ids.js';
import type { Logger } from '../../../kernel/logger.js';
import { noopLogger } from '../../../kernel/logger.js';
import type { ObjectStoragePort } from '../../../kernel/object-storage.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import type { TenantScope, TransactionRunner } from '../../../kernel/scope.js';
import { SourceKindSchema } from '../../../kernel/source-kind.js';
import type { EventLedger } from '../../ledger/index.js';
import { type Document, DocumentKindSchema, NewDocumentSchema } from '../domain/document.js';
import { type DocumentText, DocumentTextSchema } from '../domain/document-text.js';
import type { DocumentRepository, DocumentTextRepository, TextExtractorPort } from './ports.js';

/**
 * INGEST (ADR-0012 §1): stores the bytes content-addressed, records the
 * document, extracts its text with offsets, and appends `DocumentReceived`
 * to the ledger with provenance — all idempotent on `sourceRef`, so a
 * redelivered message or a re-run poll never creates a second document.
 *
 * Storage happens before the transaction (it is idempotent and may be slow);
 * the row, the texts and the event are one transaction.
 */
export const IngestDocumentInputSchema = z
  .object({
    tenantId: OrganizationIdSchema,
    kind: DocumentKindSchema,
    parentId: DocumentIdSchema.optional(),
    sourceKind: SourceKindSchema,
    sourceRef: z.string().trim().min(1).max(500),
    externalId: z.string().trim().min(1).max(500).optional(),
    body: z.instanceof(Uint8Array),
    contentType: z.string().trim().min(1).max(255),
    filename: z.string().trim().min(1).max(255).optional(),
    receivedAt: z.date(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    /** Who or what ingested it — recorded as provenance actor. */
    actor: ActorSchema,
    /** The component that recorded it (`connectors.mailbox`, `api.ingest`). */
    recordedBy: z.string().trim().min(1).max(100),
  })
  .strict();
export type IngestDocumentInput = z.input<typeof IngestDocumentInputSchema>;

export interface IngestedDocument {
  readonly document: Document;
  readonly texts: readonly DocumentText[];
  /** True when the source reference was already known: nothing new was stored. */
  readonly duplicate: boolean;
}

export interface IngestDocumentDependencies {
  readonly transactions: TransactionRunner;
  readonly documents: DocumentRepository;
  readonly texts: DocumentTextRepository;
  readonly storage: ObjectStoragePort;
  readonly extractor: TextExtractorPort;
  readonly ledger: EventLedger;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export const DOCUMENT_RECEIVED = 'DocumentReceived';
export const DOCUMENT_STREAM_TYPE = 'document';

export class IngestDocument {
  private readonly deps: IngestDocumentDependencies;
  private readonly logger: Logger;

  constructor(deps: IngestDocumentDependencies) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
  }

  async execute(rawInput: IngestDocumentInput): Promise<Result<IngestedDocument, DomainError>> {
    const parsed = IngestDocumentInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return err(
        validationErrorFromZod(parsed.error, 'INVALID_DOCUMENT', 'The document input is invalid.'),
      );
    }
    const input = parsed.data;

    const known = await this.deps.transactions.withTenant(input.tenantId, async (scope) =>
      this.existing(scope, input.sourceRef),
    );
    if (known !== undefined) return ok(known);

    const stored = await this.deps.storage.put({
      tenantId: input.tenantId,
      namespace: 'documents',
      body: input.body,
      contentType: input.contentType,
      ...(input.filename === undefined ? {} : { filename: input.filename }),
    });
    if (!stored.ok) return err(stored.error);

    const extraction = await this.extractTexts(input);
    const id = newDocumentId();
    const now = this.deps.clock.now();
    const texts: DocumentText[] = extraction.texts.map((part) =>
      DocumentTextSchema.parse({
        documentId: id,
        part: part.part,
        text: part.text,
        charCount: part.text.length,
        extractor: this.deps.extractor.name,
        extractedAt: now,
      }),
    );

    try {
      return await this.deps.transactions.withTenant(input.tenantId, async (scope) => {
        const document = await this.deps.documents.insert(
          scope,
          NewDocumentSchema.parse({
            id,
            organizationId: input.tenantId,
            kind: input.kind,
            parentId: input.parentId ?? null,
            sourceKind: input.sourceKind,
            sourceRef: input.sourceRef,
            externalId: input.externalId ?? null,
            objectKey: stored.value.key,
            contentHash: stored.value.contentHash,
            contentType: input.contentType,
            filename: input.filename ?? null,
            sizeBytes: input.body.byteLength,
            receivedAt: input.receivedAt,
            metadata: input.metadata,
            textStatus: extraction.status,
          }),
        );
        if (texts.length > 0) await this.deps.texts.replace(scope, id, texts);
        const appended = await this.deps.ledger.append(
          scope,
          { type: DOCUMENT_STREAM_TYPE, id },
          [
            {
              eventType: DOCUMENT_RECEIVED,
              schemaVersion: 1,
              payload: {
                documentId: id,
                kind: input.kind,
                parentId: input.parentId ?? null,
                contentType: input.contentType,
                contentHash: stored.value.contentHash,
                filename: input.filename ?? null,
                sizeBytes: input.body.byteLength,
                textStatus: extraction.status,
              },
              provenance: {
                sourceKind: input.sourceKind,
                sourceRef: input.sourceRef,
                actor: input.actor,
                evidenceRefs: [`object:${stored.value.key}`],
                recordedBy: input.recordedBy,
              },
              occurredAt: input.receivedAt,
              idempotencyKey: `document-received:${input.sourceRef}`,
            },
          ],
          'none',
        );
        if (!appended.ok) return err(appended.error);
        return ok({ document, texts, duplicate: false });
      });
    } catch (error) {
      // A concurrent ingestion of the same source reference: the other writer won.
      if (isDomainError(error) && error instanceof ConflictError) {
        const winner = await this.deps.transactions.withTenant(input.tenantId, (scope) =>
          this.existing(scope, input.sourceRef),
        );
        if (winner !== undefined) return ok(winner);
      }
      throw error;
    }
  }

  private async existing(
    scope: TenantScope,
    sourceRef: string,
  ): Promise<IngestedDocument | undefined> {
    const document = await this.deps.documents.findBySourceRef(scope, sourceRef);
    if (document === undefined) return undefined;
    const texts = await this.deps.texts.listByDocument(scope, document.id);
    return { document, texts, duplicate: true };
  }

  private async extractTexts(input: {
    body: Uint8Array;
    contentType: string;
    filename?: string | undefined;
  }): Promise<{ texts: { part: number; text: string }[]; status: Document['textStatus'] }> {
    const filename = input.filename ?? null;
    if (!this.deps.extractor.supports(input.contentType, filename)) {
      return { texts: [], status: 'unsupported' };
    }
    const extracted = await this.deps.extractor.extract({
      body: input.body,
      contentType: input.contentType,
      filename,
    });
    if (!extracted.ok) {
      this.logger.warn('text extraction failed', {
        contentType: input.contentType,
        code: extracted.error.code,
      });
      return { texts: [], status: 'failed' };
    }
    return { texts: extracted.value, status: 'extracted' };
  }
}
