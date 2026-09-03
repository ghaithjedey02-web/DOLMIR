import type { Clock } from '../../../kernel/clock.js';
import { type Actor, ActorType } from '../../../kernel/context.js';
import {
  type DomainError,
  InfrastructureError,
  NotFoundError,
  PreconditionFailedError,
  toDomainError,
} from '../../../kernel/errors.js';
import type { ConnectionId, OrganizationId } from '../../../kernel/ids.js';
import { type Logger, noopLogger } from '../../../kernel/logger.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import type { TransactionRunner } from '../../../kernel/scope.js';
import type { AuditRecorder } from '../../audit/index.js';
import type { TenantConnection } from '../domain/connection.js';
import type { ConnectionSecrets } from './connection-secrets.js';
import type { IngestMailboxMessage } from './ingest-mailbox-message.js';
import type {
  ConnectionRepository,
  MailboxConnectorFactory,
  MailboxConnectorPort,
  MailboxCursor,
} from './ports.js';

/**
 * One pass over a mailbox (ADR-0013 §4). Runs inside the tenant's scope, and
 * is safe to repeat: the cursor only advances over messages that were
 * ingested, and ingestion itself is idempotent on the source reference, so a
 * retry after a crash re-reads at worst a handful of messages and creates no
 * duplicates.
 *
 * A provider failure is a value, not an exception: the connection is marked
 * with its last error so an operator can see it, and the job retries.
 */
export const POLL_COMPLETED_ACTION = 'mailbox.polled';

export interface PollMailboxDependencies {
  readonly transactions: TransactionRunner;
  readonly connections: ConnectionRepository;
  readonly secrets: ConnectionSecrets;
  readonly factory: MailboxConnectorFactory;
  readonly ingest: IngestMailboxMessage;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Messages per pass. The job runs again immediately when the mailbox has more. */
  readonly batchSize?: number;
}

export interface PollReport {
  readonly connectionId: ConnectionId;
  readonly listed: number;
  readonly ingested: number;
  readonly duplicates: number;
  /** Messages that vanished between listing and fetching. */
  readonly missing: number;
  /** True when the provider renumbered its messages and the cursor was reset. */
  readonly reset: boolean;
  /** True when the mailbox had more messages than this pass took. */
  readonly more: boolean;
}

const POLL_ACTOR: Actor = { type: ActorType.SYSTEM, id: 'connectors.mailbox_poll' };

export class PollMailbox {
  private readonly deps: PollMailboxDependencies;
  private readonly logger: Logger;
  private readonly batchSize: number;

  constructor(deps: PollMailboxDependencies) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
    this.batchSize = deps.batchSize ?? 25;
  }

  async execute(
    tenantId: OrganizationId,
    connectionId: ConnectionId,
  ): Promise<Result<PollReport, DomainError>> {
    const opened = await this.deps.transactions.withTenant(tenantId, async (scope) => {
      const connection = await this.deps.connections.findById(scope, connectionId);
      if (connection === undefined) {
        return err(new NotFoundError('CONNECTION_NOT_FOUND', 'The connection was not found.'));
      }
      if (connection.capability !== 'mailbox') {
        return err(
          new PreconditionFailedError('NOT_A_MAILBOX', 'The connection is not a mailbox.', {
            details: { capability: connection.capability },
          }),
        );
      }
      return this.deps.secrets.openConnection(connection);
    });
    if (!opened.ok) return err(opened.error);

    const connector = this.deps.factory.create(opened.value.connection, opened.value.credentials);
    if (!connector.ok) {
      await this.markFailed(tenantId, connectionId, connector.error);
      return err(connector.error);
    }

    try {
      const report = await this.drain(tenantId, opened.value.connection, connector.value);
      if (!report.ok) {
        await this.markFailed(tenantId, connectionId, report.error);
        return report;
      }
      return report;
    } catch (error) {
      const failure = toDomainError(error, 'MAILBOX_POLL_FAILED');
      await this.markFailed(tenantId, connectionId, failure);
      return err(failure);
    } finally {
      await connector.value.close();
    }
  }

  private async drain(
    tenantId: OrganizationId,
    connection: TenantConnection,
    connector: MailboxConnectorPort,
  ): Promise<Result<PollReport, DomainError>> {
    const listing = await connector.listNew(cursorOf(connection), this.batchSize);
    if (!listing.ok) return err(listing.error);

    let ingested = 0;
    let duplicates = 0;
    let missing = 0;
    let cursor = cursorOf(connection);
    if (listing.value.reset)
      cursor = { generation: listing.value.cursor.generation, lastUid: null };

    for (const reference of listing.value.messages) {
      const raw = await connector.fetchRaw(reference.uid);
      if (!raw.ok) return err(raw.error);
      if (raw.value === undefined) {
        // Moved or deleted between listing and fetch: advance past it, do not stall the mailbox.
        missing += 1;
        cursor = { generation: listing.value.cursor.generation, lastUid: reference.uid };
        continue;
      }
      const result = await this.deps.ingest.execute({
        tenantId,
        raw: raw.value,
        sourceKind: 'EMAIL',
        sourceRef: sourceRefOf(connection, listing.value.cursor.generation, reference.uid),
        connectionId: connection.id,
        receivedAt: reference.receivedAt,
        actor: POLL_ACTOR,
        recordedBy: 'connectors.mailbox_poll',
      });
      if (!result.ok) {
        // The cursor stays where it was, so this message is retried rather than skipped.
        return err(result.error);
      }
      if (result.value.duplicate) duplicates += 1;
      else ingested += 1;
      cursor = { generation: listing.value.cursor.generation, lastUid: reference.uid };
    }

    const report: PollReport = {
      connectionId: connection.id,
      listed: listing.value.messages.length,
      ingested,
      duplicates,
      missing,
      reset: listing.value.reset,
      more: listing.value.messages.length >= this.batchSize,
    };
    await this.markPolled(tenantId, connection, cursor, report);
    this.logger.info('mailbox polled', { ...report, connectionId: connection.id });
    return ok(report);
  }

  private async markPolled(
    tenantId: OrganizationId,
    connection: TenantConnection,
    cursor: MailboxCursor,
    report: PollReport,
  ): Promise<void> {
    await this.deps.transactions.withTenant(tenantId, async (scope) => {
      const current = await this.deps.connections.findById(scope, connection.id);
      if (current === undefined) return;
      await this.deps.connections.update(scope, connection.id, current.version, {
        syncState: { generation: cursor.generation, lastUid: cursor.lastUid },
        lastSyncAt: this.deps.clock.now(),
        status: 'active',
        lastError: null,
      });
      await this.deps.audit.record(scope, {
        organizationId: tenantId,
        actor: POLL_ACTOR,
        action: POLL_COMPLETED_ACTION,
        target: { type: 'connection', id: connection.id },
        details: {
          listed: report.listed,
          ingested: report.ingested,
          duplicates: report.duplicates,
          missing: report.missing,
          reset: report.reset,
        },
      });
    });
  }

  private async markFailed(
    tenantId: OrganizationId,
    connectionId: ConnectionId,
    error: DomainError,
  ): Promise<void> {
    this.logger.warn('mailbox poll failed', { connectionId, code: error.code });
    await this.deps.transactions.withTenant(tenantId, async (scope) => {
      const current = await this.deps.connections.findById(scope, connectionId);
      if (current === undefined) return;
      await this.deps.connections.update(scope, connectionId, current.version, {
        status: 'error',
        // The code and message of a platform error; never a credential, never a body.
        lastError: `${error.code}: ${error.message}`.slice(0, 2000),
      });
      await this.deps.audit.record(scope, {
        organizationId: tenantId,
        actor: POLL_ACTOR,
        action: POLL_COMPLETED_ACTION,
        target: { type: 'connection', id: connectionId },
        outcome: 'failure',
        details: { reason: error.code },
      });
    });
  }
}

function cursorOf(connection: TenantConnection): MailboxCursor {
  const generation = connection.syncState['generation'];
  const lastUid = connection.syncState['lastUid'];
  return {
    generation: typeof generation === 'string' ? generation : null,
    lastUid: typeof lastUid === 'string' ? lastUid : null,
  };
}

/** Stable per tenant, so re-polling the same message never creates a second document. */
function sourceRefOf(connection: TenantConnection, generation: string | null, uid: string): string {
  return `mailbox:${connection.id}:${generation ?? 'none'}:${uid}`;
}

export { InfrastructureError };
