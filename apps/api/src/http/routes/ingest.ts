import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  OrganizationIdSchema,
  UnauthenticatedError,
  ValidationError,
  validationErrorFromZod,
} from '@dolmir/core';

import type { Container } from '../../composition/container.js';

/**
 * The provider-agnostic inbound path (ADR-0013 §3a). It carries no bearer
 * token: the request is authenticated by its HMAC signature against a key the
 * tenant issued, and the signature is checked before the body is parsed. A
 * forwarding rule, an automation node or a script can deliver a message here
 * with no OAuth application to register.
 *
 * The organisation is named in the path and proved by the signature. An
 * unknown key, a disabled key and another tenant's key all answer the same
 * way, so a caller learns nothing about tenants it does not belong to.
 */
export const MAX_INGEST_BODY_BYTES = 26 * 1024 * 1024;

export function ingestRoutes(container: Container): (app: FastifyInstance) => Promise<void> {
  return async (app) => {
    app.addContentTypeParser(
      ['message/rfc822', 'application/octet-stream', 'text/plain'],
      { parseAs: 'buffer', bodyLimit: MAX_INGEST_BODY_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );

    app.post('/messages', { bodyLimit: MAX_INGEST_BODY_BYTES }, async (request, reply) => {
      const params = z.object({ orgId: OrganizationIdSchema }).safeParse(request.params);
      if (!params.success) {
        throw validationErrorFromZod(
          params.error,
          'INVALID_ORGANIZATION_ID',
          'The organization id is invalid.',
        );
      }
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        throw new ValidationError(
          'EMPTY_BODY',
          'Send the raw MIME message as the request body, with content-type message/rfc822.',
        );
      }
      const headers: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers[name.toLowerCase()] = value;
      }
      const result = await container.connectors.receiveSigned.execute({
        tenantId: params.data.orgId,
        headers,
        body: Uint8Array.from(body),
      });
      if (!result.ok) {
        if (result.error instanceof UnauthenticatedError) {
          void reply.header('www-authenticate', 'DOLMIR-HMAC-SHA256');
        }
        throw result.error;
      }
      return reply.code(result.value.duplicate ? 200 : 202).send({
        documentId: result.value.document.id,
        duplicate: result.value.duplicate,
        attachments: result.value.attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          contentType: attachment.contentType,
          textStatus: attachment.textStatus,
        })),
        rejectedAttachments: result.value.rejectedAttachments,
        messageId: result.value.message.messageId,
        subject: result.value.message.subject,
      });
    });
  };
}
