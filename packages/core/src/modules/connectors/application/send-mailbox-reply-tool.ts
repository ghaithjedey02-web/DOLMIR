import { z } from 'zod';

import type { Clock } from '../../../kernel/clock.js';
import {
  type DomainError,
  NotFoundError,
  PreconditionFailedError,
} from '../../../kernel/errors.js';
import { ConnectionIdSchema } from '../../../kernel/ids.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import { Permission } from '../../access/index.js';
import { ToolEffect } from '../../../kernel/action-policy.js';
import { type ToolDefinition, defineTool } from '../../../ai/index.js';
import type { ConnectionSecrets } from './connection-secrets.js';
import type { ConnectionRepository, MailboxConnectorFactory } from './ports.js';

/**
 * The platform's one outbound mail capability, shared by every AI System
 * (ADR-0013 §4). It is an `act` tool, so the company's action policy decides
 * whether it may run at all, and its default level is REQUIRE_APPROVAL: a
 * reply leaves only after a human with `decisions:approve` said so, and it
 * runs under that human's permissions.
 *
 * The handler receives validated input and the caller's tenant scope. It
 * never receives credentials: it resolves the connection inside the scope, so
 * row-level security already limits it to the caller's tenant, and the
 * plaintext exists only inside the connectors module.
 */
export const SendMailboxReplyInputSchema = z
  .object({
    /** The mailbox connection to send through; must belong to the caller's tenant. */
    connectionId: ConnectionIdSchema,
    to: z.array(z.email()).min(1).max(20),
    cc: z.array(z.email()).max(20).default([]),
    subject: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(20_000),
    /** Message-ID this answers, so the recipient's client threads it. */
    inReplyTo: z.string().trim().min(1).max(500).optional(),
    references: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  })
  .strict();
export type SendMailboxReplyInput = z.infer<typeof SendMailboxReplyInputSchema>;

export const SendMailboxReplyOutputSchema = z
  .object({
    messageId: z.string(),
    acceptedAt: z.iso.datetime(),
    connectionId: ConnectionIdSchema,
  })
  .strict();
export type SendMailboxReplyOutput = z.infer<typeof SendMailboxReplyOutputSchema>;

export const SEND_MAILBOX_REPLY_TOOL = 'send_mailbox_reply';

export interface SendMailboxReplyDependencies {
  readonly connections: ConnectionRepository;
  readonly secrets: ConnectionSecrets;
  readonly factory: MailboxConnectorFactory;
  readonly clock: Clock;
}

export function createSendMailboxReplyTool(
  deps: SendMailboxReplyDependencies,
): ToolDefinition<SendMailboxReplyInput, SendMailboxReplyOutput> {
  return defineTool({
    name: SEND_MAILBOX_REPLY_TOOL,
    description:
      'Send an e-mail reply through one of the company mailbox connections. Use it to answer a customer or supplier message. The reply leaves only after a human approves it.',
    effect: ToolEffect.ACT,
    permission: Permission.AI_INVOKE,
    input: SendMailboxReplyInputSchema,
    output: SendMailboxReplyOutputSchema,
    handler: async (input, context): Promise<Result<SendMailboxReplyOutput, DomainError>> => {
      const connection = await deps.connections.findById(context.scope, input.connectionId);
      if (connection === undefined) {
        return err(
          new NotFoundError('CONNECTION_NOT_FOUND', 'The mailbox connection was not found.'),
        );
      }
      if (connection.capability !== 'mailbox') {
        return err(
          new PreconditionFailedError('NOT_A_MAILBOX', 'That connection is not a mailbox.', {
            details: { capability: connection.capability },
          }),
        );
      }
      const opened = deps.secrets.openConnection(connection);
      if (!opened.ok) return err(opened.error);
      const connector = deps.factory.create(connection, opened.value.credentials);
      if (!connector.ok) return err(connector.error);
      try {
        const sent = await connector.value.send({
          to: input.to,
          ...(input.cc.length === 0 ? {} : { cc: input.cc }),
          subject: input.subject,
          text: input.body,
          ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
          ...(input.references.length === 0 ? {} : { references: input.references }),
          // Carried from the approved action, so a retry is the same message.
          ...(context.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: context.idempotencyKey }),
        });
        if (!sent.ok) return err(sent.error);
        return ok({
          messageId: sent.value.messageId,
          acceptedAt: sent.value.acceptedAt.toISOString(),
          connectionId: connection.id,
        });
      } finally {
        await connector.value.close();
      }
    },
  });
}
