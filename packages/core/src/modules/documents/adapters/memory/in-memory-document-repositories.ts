import { type Clock, systemClock } from '../../../../kernel/clock.js';
import { ConflictError, ForbiddenError } from '../../../../kernel/errors.js';
import type { DocumentId } from '../../../../kernel/ids.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import type {
  DocumentQuery,
  DocumentRepository,
  DocumentTextRepository,
} from '../../application/ports.js';
import type { Document, NewDocument, TextStatus } from '../../domain/document.js';
import type { DocumentText } from '../../domain/document-text.js';

/** Same visibility rules as the database: a tenant scope sees only its rows; system scope sees all. */
const visible = (scope: Scope, organizationId: string): boolean =>
  scope.kind === 'system' || scope.tenantId === organizationId;

export class InMemoryDocumentStore {
  readonly documents = new Map<DocumentId, Document>();
  readonly texts = new Map<DocumentId, DocumentText[]>();
  readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }
}

export class InMemoryDocumentRepository implements DocumentRepository {
  private readonly store: InMemoryDocumentStore;

  constructor(store: InMemoryDocumentStore) {
    this.store = store;
  }

  async insert(scope: TenantScope, document: NewDocument): Promise<Document> {
    if (document.organizationId !== scope.tenantId) {
      throw new ForbiddenError('DATABASE_ACCESS_DENIED', 'Row-level security refused the insert.');
    }
    for (const existing of this.store.documents.values()) {
      if (
        existing.organizationId === document.organizationId &&
        existing.sourceRef === document.sourceRef
      ) {
        throw new ConflictError('UNIQUE_VIOLATION', 'A record with the same key already exists.');
      }
    }
    const stored: Document = { ...document, createdAt: this.store.clock.now() };
    this.store.documents.set(stored.id, stored);
    return stored;
  }

  async findById(scope: Scope, id: DocumentId): Promise<Document | undefined> {
    const document = this.store.documents.get(id);
    return document !== undefined && visible(scope, document.organizationId) ? document : undefined;
  }

  async findBySourceRef(scope: TenantScope, sourceRef: string): Promise<Document | undefined> {
    for (const document of this.store.documents.values()) {
      if (document.organizationId === scope.tenantId && document.sourceRef === sourceRef) {
        return document;
      }
    }
    return undefined;
  }

  async listChildren(scope: Scope, parentId: DocumentId): Promise<Document[]> {
    return [...this.store.documents.values()]
      .filter((document) => document.parentId === parentId)
      .filter((document) => visible(scope, document.organizationId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async list(scope: TenantScope, query: DocumentQuery): Promise<Document[]> {
    return [...this.store.documents.values()]
      .filter((document) => document.organizationId === scope.tenantId)
      .filter((document) => query.kind === undefined || document.kind === query.kind)
      .filter((document) => query.topLevelOnly !== true || document.parentId === null)
      .filter((document) => query.before === undefined || document.receivedAt < query.before)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, query.limit);
  }

  async setTextStatus(scope: Scope, id: DocumentId, status: TextStatus): Promise<void> {
    const document = await this.findById(scope, id);
    if (document === undefined) return;
    this.store.documents.set(id, { ...document, textStatus: status });
  }
}

export class InMemoryDocumentTextRepository implements DocumentTextRepository {
  private readonly store: InMemoryDocumentStore;

  constructor(store: InMemoryDocumentStore) {
    this.store = store;
  }

  async replace(
    scope: Scope,
    documentId: DocumentId,
    texts: readonly DocumentText[],
  ): Promise<void> {
    const document = this.store.documents.get(documentId);
    if (document === undefined || !visible(scope, document.organizationId)) {
      throw new ForbiddenError('DATABASE_ACCESS_DENIED', 'Row-level security refused the write.');
    }
    this.store.texts.set(
      documentId,
      [...texts].sort((a, b) => a.part - b.part),
    );
  }

  async listByDocument(scope: Scope, documentId: DocumentId): Promise<DocumentText[]> {
    const document = this.store.documents.get(documentId);
    if (document === undefined || !visible(scope, document.organizationId)) return [];
    return [...(this.store.texts.get(documentId) ?? [])];
  }
}
