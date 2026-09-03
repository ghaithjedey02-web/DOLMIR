import { createHash } from 'node:crypto';

import type { Clock } from '../../../kernel/clock.js';
import { type Actor, ActorType } from '../../../kernel/context.js';
import { type DomainError, UnauthenticatedError } from '../../../kernel/errors.js';
import type { OrganizationId } from '../../../kernel/ids.js';
import { type Logger, noopLogger } from '../../../kernel/logger.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import type { TransactionRunner } from '../../../kernel/scope.js';
import type { AuditRecorder } from '../../audit/index.js';
import { INGESTION_ENDPOINT_PROVIDER } from '../domain/connection.js';
import { verifyIngestionSignature } from '../domain/request-signing.js';
import type { ConnectionSecrets } from './connection-secrets.js';
import type { IngestMailboxMessage, IngestedMailboxMessage } from './ingest-mailbox-message.js';
import type { ConnectionRepository, IngestionNonceRepository } from './ports.js';

/**
 * The provider-agnostic inbound path (ADR-0013 §3a): a machine caller posts
 * raw MIME signed with a per-tenant shared secret. A forwarding rule, an n8n
 * node or a script can deliver messages with no OAuth application to register.
 *
 * The order is deliberate. The signature is checked first, so an unsigned body
 * is never parsed. The nonce is then claimed, so a replayed request is refused
 * before anything is stored. Ingestion itself is idempotent on the message
 * identity, so a caller that retries with a fresh nonce after a failure gets
 * the original document rather than a second one.
 */
export const SIGNATURE_REJECTED_ACTION = 'mailbox.signature_rejected';

export interface ReceiveSignedMessageDependencies {
  readonly transactions: TransactionRunner;
  readonly connections: ConnectionRepository;
  readonly secrets: ConnectionSecrets;
  readonly nonces: IngestionNonceRepository;
  readonly ingest: IngestMailboxMessage;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** How long a signature stays valid, and how long its nonce is remembered. */
  readonly toleranceSeconds?: number;
}

export interface SignedMessageInput {
  readonly tenantId: OrganizationId;
  /** Lowercase header names mapped to their values, as the transport received them. */
  readonly headers: Readonly<Record<string, unknown>>;
  readonly body: Uint8Array;
}

const SERVICE_ACTOR: Actor = { type: ActorType.SERVICE, id: 'ingestion_endpoint' };

export class ReceiveSignedMessage {
  private readonly deps: ReceiveSignedMessageDependencies;
  private readonly logger: Logger;
  private readonly toleranceSeconds: number;

  constructor(deps: ReceiveSignedMessageDependencies) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
    this.toleranceSeconds = deps.toleranceSeconds ?? 300;
  }

  async execute(input: SignedMessageInput): Promise<Result<IngestedMailboxMessage, DomainError>> {
    const authorised = await this.deps.transactions.withTenant(
      input.tenantId,
      async (scope): Promise<Result<{ keyId: string }, DomainError>> => {
        const candidates = await this.deps.connections.list(scope, {
          capability: 'ingest_endpoint',
          status: 'active',
          limit: 50,
        });
        const presented = input.headers['x-dolmir-key-id'];
        const connection = candidates.find(
          (item) =>
            item.provider === INGESTION_ENDPOINT_PROVIDER &&
            typeof presented === 'string' &&
            item.settings['keyId'] === presented,
        );
        if (connection === undefined) {
          // The same answer whether the key is unknown, disabled or belongs to
          // another tenant: a caller learns nothing about other tenants' keys.
          return err(
            new UnauthenticatedError('UNKNOWN_INGESTION_KEY', 'The signing key is not known.'),
          );
        }
        const opened = this.deps.secrets.openConnection(connection);
        if (!opened.ok) return err(opened.error);
        const secret = opened.value.credentials['secret'];
        if (typeof secret !== 'string') {
          return err(
            new UnauthenticatedError('INGESTION_KEY_UNUSABLE', 'The signing key is not usable.'),
          );
        }
        const verified = verifyIngestionSignature(
          Buffer.from(secret, 'base64'),
          input.headers,
          input.body,
          this.deps.clock.now(),
          this.toleranceSeconds,
        );
        if (!verified.ok) return err(verified.error);
        const claimed = await this.deps.nonces.claim(
          scope,
          verified.value.keyId,
          verified.value.nonce,
          new Date(verified.value.timestamp.getTime() + this.toleranceSeconds * 2000),
        );
        if (!claimed) {
          return err(
            new UnauthenticatedError('SIGNATURE_REPLAYED', 'This request was already delivered.'),
          );
        }
        return ok({ keyId: verified.value.keyId });
      },
    );

    if (!authorised.ok) {
      await this.recordRejection(input, authorised.error);
      return err(authorised.error);
    }

    return this.deps.ingest.execute({
      tenantId: input.tenantId,
      raw: input.body,
      sourceKind: 'EMAIL',
      sourceRef: `ingest:${authorised.value.keyId}:${bodyDigest(input.body)}`,
      receivedAt: this.deps.clock.now(),
      actor: SERVICE_ACTOR,
      recordedBy: 'connectors.ingestion_endpoint',
    });
  }

  private async recordRejection(input: SignedMessageInput, error: DomainError): Promise<void> {
    const keyId = input.headers['x-dolmir-key-id'];
    this.logger.warn('signed message rejected', { code: error.code });
    await this.deps.transactions.withTenant(input.tenantId, async (scope) => {
      await this.deps.audit.record(scope, {
        organizationId: input.tenantId,
        actor: SERVICE_ACTOR,
        action: SIGNATURE_REJECTED_ACTION,
        outcome: 'denied',
        details: {
          reason: error.code,
          // The presented key id identifies the caller; the signature and body never appear.
          keyId: typeof keyId === 'string' ? keyId : null,
          sizeBytes: input.body.byteLength,
        },
      });
    });
  }
}

/**
 * Identity of the delivered bytes. Two deliveries of the same message produce
 * the same source reference, so ingestion deduplicates them even when the
 * caller sends a fresh nonce.
 */
function bodyDigest(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}
