import Fastify, { type FastifyInstance } from 'fastify';

import { isDomainError, toDomainError } from '@dolmir/core';

import type { Container } from '../composition/container.js';
import { authHook, contextHook, generateRequestId, tenantHook } from './hooks.js';
import { problemFromDomainError, problemFromStatus } from './problem-details.js';
import { caseRoutes } from './routes/cases.js';
import { healthRoutes } from './routes/health.js';
import { ingestRoutes } from './routes/ingest.js';
import { meRoutes } from './routes/me.js';
import { organizationRoutes } from './routes/organizations.js';
import { workspaceRoutes } from './routes/workspace.js';
import './request-state.js';

export interface AppOptions {
  /** Maximum request body, bytes. */
  readonly bodyLimit?: number;
}

/**
 * The HTTP delivery adapter: Fastify with DOLMIR's request context, bearer
 * authentication, tenant resolution, RFC 9457 errors and the Phase 0 routes.
 * Fastify's own logger is off; every line goes through the platform `Logger`
 * so redaction and context binding apply uniformly.
 */
export async function buildApp(
  container: Container,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const { logger } = container;
  const app = Fastify({
    logger: false,
    bodyLimit: options.bodyLimit ?? 1_048_576,
    requestIdHeader: false,
    genReqId: (raw) => generateRequestId(raw.headers),
    trustProxy: false,
  });

  app.decorateRequest('dolmir');
  app.addHook('onRequest', contextHook());

  app.addHook('onSend', async (_request, reply, payload) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('cache-control', 'no-store');
    void reply.header('referrer-policy', 'no-referrer');
    return payload;
  });

  app.addHook('onResponse', (request, reply, done) => {
    logger.info('request completed', {
      method: request.method,
      route: request.routeOptions.url ?? request.url.split('?')[0] ?? request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
    done();
  });

  app.setNotFoundHandler(async (request, reply) => {
    const problem = problemFromStatus(
      404,
      'ROUTE_NOT_FOUND',
      `No route for ${request.method} ${request.url.split('?')[0] ?? request.url}.`,
      request.url,
      request.id,
    );
    return reply.code(404).type('application/problem+json; charset=utf-8').send(problem);
  });

  app.setErrorHandler(async (error: unknown, request, reply) => {
    const instance = request.url;
    const requestId = request.id;
    if (isDomainError(error)) {
      const problem = problemFromDomainError(error, instance, requestId);
      if (problem.status >= 500) {
        logger.error('request failed', {
          code: error.code,
          category: error.category,
          message: error.message,
          statusCode: problem.status,
        });
      }
      // A route that authenticates differently (the signed ingestion endpoint)
      // sets its own challenge; bearer is only the default.
      if (problem.status === 401 && reply.getHeader('www-authenticate') === undefined) {
        void reply.header('www-authenticate', 'Bearer realm="dolmir"');
      }
      return reply
        .code(problem.status)
        .type('application/problem+json; charset=utf-8')
        .send(problem);
    }
    const framework = describeFrameworkError(error);
    if (framework.statusCode >= 400 && framework.statusCode < 500) {
      // Fastify's own client errors (malformed JSON, oversized body, unsupported media type…).
      const problem = problemFromStatus(
        framework.statusCode,
        framework.code,
        framework.message,
        instance,
        requestId,
      );
      return reply
        .code(framework.statusCode)
        .type('application/problem+json; charset=utf-8')
        .send(problem);
    }
    const internal = toDomainError(error, 'UNHANDLED_ERROR');
    logger.error('unhandled error', {
      name: framework.name,
      message: framework.message,
      code: internal.code,
    });
    const problem = problemFromDomainError(internal, instance, requestId);
    return reply.code(problem.status).type('application/problem+json; charset=utf-8').send(problem);
  });

  await app.register(healthRoutes(container));
  // Signature-authenticated, so it sits outside the bearer scope on purpose.
  await app.register(ingestRoutes(container), { prefix: '/v1/orgs/:orgId/ingest' });
  await app.register(
    async (v1) => {
      v1.addHook('preHandler', authHook(container));
      await v1.register(meRoutes(container));
      await v1.register(
        async (orgs) => {
          orgs.addHook('preHandler', tenantHook(container));
          await orgs.register(organizationRoutes(container));
          await orgs.register(caseRoutes(container));
          await orgs.register(workspaceRoutes(container));
        },
        { prefix: '/orgs/:orgId' },
      );
    },
    { prefix: '/v1' },
  );

  return app;
}

/** Reads what Fastify attaches to its own errors without trusting the shape. */
function describeFrameworkError(error: unknown): {
  statusCode: number;
  code: string;
  name: string;
  message: string;
} {
  const record: Record<string, unknown> =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const statusCode = typeof record['statusCode'] === 'number' ? record['statusCode'] : 500;
  const code =
    typeof record['code'] === 'string' && record['code'].length > 0
      ? record['code']
      : 'BAD_REQUEST';
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : 'Error';
  return { statusCode, code, name, message };
}
