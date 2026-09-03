import type { DomainError } from '../../../kernel/errors.js';
import type { ConnectionId, DocumentId, OrganizationId } from '../../../kernel/ids.js';
import type { Result } from '../../../kernel/result.js';
import type { Scope, TenantScope } from '../../../kernel/scope.js';
import type {
  ConnectionCapability,
  ConnectionSettings,
  ConnectionStatus,
  EncryptedSecret,
  ProviderKey,
  TenantConnection,
} from '../domain/connection.js';
import type { InboundMessage } from '../domain/inbound-message.js';

/**
 * Ports of the connectors module (ADR-0013). Every port is per capability,
 * never per vendor: an adapter for Gmail or Microsoft Graph implements the
 * same `MailboxConnectorPort` and nothing in the business layer changes.
 */
export interface NewConnection {
  readonly id: ConnectionId;
  readonly organizationId: OrganizationId;
  readonly capability: ConnectionCapability;
  readonly provider: ProviderKey;
  readonly displayName: string;
  readonly settings: ConnectionSettings;
  readonly credentials: EncryptedSecret;
}

export interface ConnectionPatch {
  readonly displayName?: string;
  readonly settings?: ConnectionSettings;
  readonly credentials?: EncryptedSecret;
  readonly status?: ConnectionStatus;
  readonly lastError?: string | null;
  readonly syncState?: Readonly<Record<string, unknown>>;
  readonly lastSyncAt?: Date | null;
}

export interface ConnectionQuery {
  readonly capability?: ConnectionCapability;
  readonly status?: ConnectionStatus;
  readonly limit: number;
}

export interface ConnectionRepository {
  insert(scope: TenantScope, connection: NewConnection): Promise<TenantConnection>;
  /** Optimistic: the update applies only when the stored version still matches. */
  update(
    scope: TenantScope,
    id: ConnectionId,
    expectedVersion: number,
    patch: ConnectionPatch,
  ): Promise<TenantConnection | undefined>;
  findById(scope: Scope, id: ConnectionId): Promise<TenantConnection | undefined>;
  list(scope: TenantScope, query: ConnectionQuery): Promise<TenantConnection[]>;
  /** Every active connection of a capability across tenants; system scope only, for the poll scheduler. */
  listActiveAcrossTenants(
    scope: Scope,
    capability: ConnectionCapability,
    limit: number,
  ): Promise<TenantConnection[]>;
}

/**
 * Replay protection for the signed ingestion endpoint: claiming a nonce is an
 * insert, so a second claim of the same nonce loses on the primary key.
 */
export interface IngestionNonceRepository {
  /** True when the nonce was claimed by this call; false when it was already used. */
  claim(scope: TenantScope, keyId: string, nonce: string, expiresAt: Date): Promise<boolean>;
}

/** Turns raw MIME bytes into the canonical message. Deterministic; never throws. */
export interface MimeParserPort {
  readonly name: string;
  parse(raw: Uint8Array): Promise<Result<InboundMessage, DomainError>>;
}

/** Where a provider's polling stopped. Opaque to the business layer, stored per connection. */
export interface MailboxCursor {
  /** Invalidated by the provider when uids are renumbered; a change forces a full re-list. */
  readonly generation: string | null;
  readonly lastUid: string | null;
}

export interface MailboxMessageRef {
  /** Stable within a generation; part of the document's source reference. */
  readonly uid: string;
  readonly receivedAt: Date;
  readonly sizeBytes: number;
}

export interface MailboxListing {
  readonly messages: readonly MailboxMessageRef[];
  readonly cursor: MailboxCursor;
  /** True when the provider renumbered and the cursor was reset. */
  readonly reset: boolean;
}

export interface OutboundMessage {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /** Message-ID this reply answers, so the customer's client threads it. */
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
}

export interface SentMessage {
  readonly messageId: string;
  readonly acceptedAt: Date;
}

export interface MailboxProbe {
  readonly provider: ProviderKey;
  readonly mailbox: string;
  readonly messageCount: number;
}

/**
 * One mailbox, provider-agnostic. Implementations hold a connection while
 * they live, so callers must `close()`. Failures are values: a mailbox that
 * is down is an expected outcome, not an exception.
 */
export interface MailboxConnectorPort {
  readonly provider: ProviderKey;
  test(): Promise<Result<MailboxProbe, DomainError>>;
  listNew(cursor: MailboxCursor, limit: number): Promise<Result<MailboxListing, DomainError>>;
  /** `undefined` when the message is gone (moved or deleted between listing and fetch). */
  fetchRaw(uid: string): Promise<Result<Uint8Array | undefined, DomainError>>;
  send(message: OutboundMessage): Promise<Result<SentMessage, DomainError>>;
  close(): Promise<void>;
}

/** Builds a connector from a connection and its decrypted credentials. */
export interface MailboxConnectorFactory {
  supports(provider: ProviderKey): boolean;
  create(
    connection: TenantConnection,
    credentials: Readonly<Record<string, unknown>>,
  ): Result<MailboxConnectorPort, DomainError>;
}

/**
 * How ingestion hands a document to the rest of the platform. Connectors do
 * not know what analysis is; the composition root enqueues the analysis job.
 */
export interface AnalysisScheduler {
  scheduleAnalysis(tenantId: OrganizationId, documentId: DocumentId): Promise<void>;
}
