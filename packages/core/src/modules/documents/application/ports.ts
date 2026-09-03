import type { DomainError } from '../../../kernel/errors.js';
import type { DocumentId } from '../../../kernel/ids.js';
import type { Result } from '../../../kernel/result.js';
import type { Scope, TenantScope } from '../../../kernel/scope.js';
import type { Document, DocumentKind, NewDocument, TextStatus } from '../domain/document.js';
import type { DocumentText } from '../domain/document-text.js';

export interface DocumentQuery {
  readonly limit: number;
  /** Only documents received strictly before this instant (paging). */
  readonly before?: Date;
  readonly kind?: DocumentKind;
  /** Only top-level documents (no parent) when true. */
  readonly topLevelOnly?: boolean;
}

export interface DocumentRepository {
  insert(scope: TenantScope, document: NewDocument): Promise<Document>;
  findById(scope: Scope, id: DocumentId): Promise<Document | undefined>;
  findBySourceRef(scope: TenantScope, sourceRef: string): Promise<Document | undefined>;
  listChildren(scope: Scope, parentId: DocumentId): Promise<Document[]>;
  list(scope: TenantScope, query: DocumentQuery): Promise<Document[]>;
  setTextStatus(scope: Scope, id: DocumentId, status: TextStatus): Promise<void>;
}

export interface DocumentTextRepository {
  /** Replaces the parts of a document (upsert per part). */
  replace(scope: Scope, documentId: DocumentId, texts: readonly DocumentText[]): Promise<void>;
  listByDocument(scope: Scope, documentId: DocumentId): Promise<DocumentText[]>;
}

export interface ExtractedText {
  readonly part: number;
  readonly text: string;
}

export interface TextExtractionInput {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly filename: string | null;
}

/** Turns bytes into text parts. Deterministic code, never a model. */
export interface TextExtractorPort {
  readonly name: string;
  supports(contentType: string, filename: string | null): boolean;
  extract(input: TextExtractionInput): Promise<Result<ExtractedText[], DomainError>>;
}
