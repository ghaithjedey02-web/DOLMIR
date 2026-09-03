import { z } from 'zod';

import { BytesSchema } from '../../../kernel/bytes.js';
import type { Clock } from '../../../kernel/clock.js';
import { type Actor, ActorSchema } from '../../../kernel/context.js';
import {
  type DomainError,
  ValidationError,
  validationErrorFromZod,
} from '../../../kernel/errors.js';
import { ConnectionIdSchema, OrganizationIdSchema } from '../../../kernel/ids.js';
import { type Logger, noopLogger } from '../../../kernel/logger.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import { SourceKindSchema } from '../../../kernel/source-kind.js';
import type { TransactionRunner } from '../../../kernel/scope.js';
import type { AuditRecorder } from '../../audit/index.js';
import type { Document, IngestDocument } from '../../documents/index.js';
import {
  MAX_MESSAGE_BYTES,
  type InboundMessage,
  messageMetadata,
  normaliseEmailAddress,
} from '../domain/inbound-message.js';
import { type RejectedAttachment, checkAttachments } from './attachment-safety.js';
import type { AnalysisScheduler, MimeParserPort } from './ports.js';

/**
 * INGEST and NORMALIZE for e-mail (ADR-0012 §1, ADR-0013). The raw MIME is
 * what the document stores, so its content hash is the hash of the message as
 * it arrived and the text can always be extracted again. Attachments become
 * child documents with their own bytes and hashes.
 *
 * Everything here treats the message as untrusted input: sizes and counts are
 * bounded, filenames are labels rather than paths, and nothing in the content
 * can reach policy, permissions or approvals. Ingestion is idempotent on the
 * source reference, so a redelivery or a re-poll never creates a second
 * document.
 */
export const IngestMailboxMessageInputSchema = z
  .object({
    tenantId: OrganizationIdSchema,
    /** The message exactly as it arrived. */
    raw: BytesSchema,
    sourceKind: SourceKindSchema.default('EMAIL'),
    /** Unique per tenant: `imap:<connection>:<generation>:<uid>`, `ingest:<message-id>`. */
    sourceRef: z.string().trim().min(1).max(500),
    /** The connection the message came through, when it came through one. */
    connectionId: ConnectionIdSchema.optional(),
    /** Used when the message carries no usable Date header. */
    receivedAt: z.date().optional(),
    actor: ActorSchema,
    recordedBy: z.string().trim().min(1).max(100),
  })
  .strict();
export type IngestMailboxMessageInput = z.input<typeof IngestMailboxMessageInputSchema>;

export interface IngestedMailboxMessage {
  readonly message: InboundMessage;
  readonly document: Document;
  readonly attachments: readonly Document[];
  /** Attachments that could not be stored, with the reason. Never silently dropped. */
  readonly rejectedAttachments: readonly RejectedAttachment[];
  /** True when this source reference was already ingested: nothing new was written. */
  readonly duplicate: boolean;
}

export interface IngestMailboxMessageDependencies {
  readonly transactions: TransactionRunner;
  readonly parser: MimeParserPort;
  readonly ingest: IngestDocument;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Optional: the composition root enqueues analysis. Connectors do not know what analysis is. */
  readonly scheduler?: AnalysisScheduler;
}

export const MESSAGE_INGESTED_ACTION = 'mailbox.message_ingested';

export class IngestMailboxMessage {
  private readonly deps: IngestMailboxMessageDependencies;
  private readonly logger: Logger;

  constructor(deps: IngestMailboxMessageDependencies) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
  }

  async execute(
    rawInput: IngestMailboxMessageInput,
  ): Promise<Result<IngestedMailboxMessage, DomainError>> {
    const parsed = IngestMailboxMessageInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return err(
        validationErrorFromZod(
          parsed.error,
          'INVALID_MESSAGE_INPUT',
          'The message input is invalid.',
        ),
      );
    }
    const input = parsed.data;

    if (input.raw.byteLength === 0) {
      return err(new ValidationError('EMPTY_MESSAGE', 'The message carries no bytes.'));
    }
    if (input.raw.byteLength > MAX_MESSAGE_BYTES) {
      return err(
        new ValidationError('MESSAGE_TOO_LARGE', 'The message exceeds the accepted size.', {
          details: { sizeBytes: input.raw.byteLength, maximum: MAX_MESSAGE_BYTES },
        }),
      );
    }

    const message = await this.deps.parser.parse(input.raw);
    if (!message.ok) return err(message.error);
    const attachments = checkAttachments(message.value);
    if (!attachments.ok) return err(attachments.error);

    const receivedAt = message.value.date ?? input.receivedAt ?? this.deps.clock.now();
    const metadata = {
      ...messageMetadata(message.value),
      threadKey: threadKeyOf(message.value),
      fromDomain: senderDomain(message.value),
      connectionId: input.connectionId ?? null,
      rejectedAttachments: attachments.value.rejected,
      /** The content is data, never instructions: recorded so every consumer sees it. */
      trust: 'untrusted_external',
    };

    const email = await this.deps.ingest.execute({
      tenantId: input.tenantId,
      kind: 'email',
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      ...(message.value.messageId === null ? {} : { externalId: message.value.messageId }),
      body: input.raw,
      contentType: 'message/rfc822',
      receivedAt,
      metadata,
      actor: input.actor,
      recordedBy: input.recordedBy,
    });
    if (!email.ok) return err(email.error);
    if (email.value.duplicate) {
      this.logger.debug('message already ingested', { sourceRef: input.sourceRef });
      return ok({
        message: message.value,
        document: email.value.document,
        attachments: [],
        rejectedAttachments: attachments.value.rejected,
        duplicate: true,
      });
    }

    const stored: Document[] = [];
    for (const attachment of attachments.value.accepted) {
      const child = await this.deps.ingest.execute({
        tenantId: input.tenantId,
        kind: 'attachment',
        parentId: email.value.document.id,
        sourceKind: input.sourceKind,
        sourceRef: `${input.sourceRef}#attachment:${String(attachment.index)}`,
        body: attachment.content,
        contentType: attachment.contentType,
        ...(attachment.filename === null ? {} : { filename: attachment.filename }),
        receivedAt,
        metadata: {
          index: attachment.index,
          inline: attachment.inline,
          declaredContentType: attachment.contentType,
          trust: 'untrusted_external',
        },
        actor: input.actor,
        recordedBy: input.recordedBy,
      });
      if (!child.ok) return err(child.error);
      stored.push(child.value.document);
    }

    await this.deps.transactions.withTenant(input.tenantId, async (scope) => {
      await this.deps.audit.record(scope, {
        organizationId: input.tenantId,
        actor: input.actor,
        action: MESSAGE_INGESTED_ACTION,
        target: { type: 'document', id: email.value.document.id },
        details: {
          sourceRef: input.sourceRef,
          connectionId: input.connectionId ?? null,
          attachments: stored.length,
          rejectedAttachments: attachments.value.rejected.length,
          textStatus: email.value.document.textStatus,
        },
      });
    });

    if (this.deps.scheduler !== undefined) {
      await this.deps.scheduler.scheduleAnalysis(input.tenantId, email.value.document.id);
    }
    this.logger.info('message ingested', {
      documentId: email.value.document.id,
      attachments: stored.length,
      rejectedAttachments: attachments.value.rejected.length,
    });
    return ok({
      message: message.value,
      document: email.value.document,
      attachments: stored,
      rejectedAttachments: attachments.value.rejected,
      duplicate: false,
    });
  }
}

/** Groups a conversation: the root of the References chain, else the message itself. */
export function threadKeyOf(message: InboundMessage): string | null {
  return message.references[0] ?? message.inReplyTo ?? message.messageId;
}

/** The sender's domain, used by entity resolution. Never a display name, which anyone can forge. */
export function senderDomain(message: InboundMessage): string | null {
  const address = message.from?.address;
  if (address === undefined) return null;
  const domain = normaliseEmailAddress(address).split('@')[1];
  return domain === undefined || domain.length === 0 ? null : domain;
}

export type { Actor };
