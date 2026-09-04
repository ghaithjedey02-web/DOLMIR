import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  CaseIdSchema,
  ForbiddenError,
  NotFoundError,
  Permission,
  UuidSchema,
  validationErrorFromZod,
} from '@dolmir/core';

import type { Container } from '../../composition/container.js';
import { requirePermission } from '../hooks.js';

/**
 * The attention surface: what DOLMIR found, what it recommends, and the human
 * decisions on it. Reading a case needs only membership; deciding on a
 * recommendation needs `decisions:approve`, which no AI actor can hold, and the
 * approved action then runs under the approver's own permissions — in a worker,
 * not in this request, so an approval that commits is work that will happen.
 */
const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(['open', 'awaiting_approval', 'resolved', 'dismissed']).optional(),
  systemKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .optional(),
  kind: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .optional(),
});

const DecisionBodySchema = z.object({
  note: z.string().trim().min(1).max(2000).optional(),
  /** Approving and executing in one call is the normal path; false stops after the approval. */
  execute: z.boolean().default(true),
});

const ResolveBodySchema = z.object({
  resolution: z.enum(['resolved_manually', 'dismissed']),
  note: z.string().trim().min(1).max(2000).optional(),
});

function parse<S extends z.ZodType>(schema: S, raw: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw validationErrorFromZod(parsed.error, 'INVALID_REQUEST', `The ${what} is invalid.`);
  }
  return parsed.data;
}

export function caseRoutes(container: Container): (app: FastifyInstance) => Promise<void> {
  return async (app) => {
    const tenantOf = (request: Parameters<typeof requirePermission>[1]) => {
      const tenant = request.dolmir.tenant;
      if (tenant === undefined) throw new ForbiddenError('NO_TENANT_CONTEXT', 'No organization.');
      return tenant;
    };

    app.get('/cases', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.ORGANIZATION_READ);
      const query = parse(ListQuerySchema, request.query, 'query string');
      const cases = await container.transactions.withTenant(tenant.organizationId, (scope) =>
        container.cases.repository.listCases(scope, {
          limit: query.limit,
          ...(query.status === undefined ? {} : { statuses: [query.status] }),
          ...(query.systemKey === undefined ? {} : { systemKey: query.systemKey }),
          ...(query.kind === undefined ? {} : { kind: query.kind }),
        }),
      );
      return { cases };
    });

    app.get('/cases/:caseId', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.ORGANIZATION_READ);
      const params = parse(z.object({ caseId: CaseIdSchema }), request.params, 'case id');
      const detail = await container.transactions.withTenant(tenant.organizationId, (scope) =>
        container.cases.engine.detail(scope, params.caseId),
      );
      if (detail === undefined)
        throw new NotFoundError('CASE_NOT_FOUND', 'The case was not found.');
      return detail;
    });

    app.post('/cases/:caseId/resolve', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.DECISIONS_APPROVE);
      const params = parse(z.object({ caseId: CaseIdSchema }), request.params, 'case id');
      const body = parse(ResolveBodySchema, request.body ?? {}, 'request body');
      const resolved = await container.cases.engine.resolve(
        tenant,
        params.caseId,
        body.resolution,
        body.note ?? null,
      );
      if (!resolved.ok) throw resolved.error;
      return { case: resolved.value };
    });

    for (const decision of ['approve', 'reject'] as const) {
      app.post(`/recommendations/:recommendationId/${decision}`, async (request) => {
        const tenant = tenantOf(request);
        // The human gate. An AI actor can never hold this permission (ADR-0011).
        requirePermission(container, request, Permission.DECISIONS_APPROVE);
        const params = parse(
          z.object({ recommendationId: UuidSchema }),
          request.params,
          'recommendation id',
        );
        const body = parse(DecisionBodySchema, request.body ?? {}, 'request body');
        const decided = await container.cases.engine.decide(
          tenant,
          params.recommendationId,
          decision === 'approve' ? 'approved' : 'rejected',
          body.note ?? null,
        );
        if (!decided.ok) throw decided.error;
        if (decision === 'reject' || !body.execute) {
          return { recommendation: decided.value, action: null };
        }
        // The approval is committed and the entitlement to act with it is
        // durable, so the work no longer depends on this request: it is handed
        // to a worker. `action` is present when the queue ran the handler
        // before the response, and null when it has not run yet — the case
        // carries the outcome either way.
        await container.cases.engine.scheduleExecution(
          tenant.organizationId,
          params.recommendationId,
        );
        const action = await container.transactions.withTenant(
          tenant.organizationId,
          async (scope) => {
            const actions = await container.cases.repository.listActions(
              scope,
              decided.value.caseId,
            );
            return (
              actions.find((item) => item.recommendationId === params.recommendationId) ?? null
            );
          },
        );
        return { recommendation: decided.value, action };
      });
    }

    app.get('/documents/:documentId/texts', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.ORGANIZATION_READ);
      const params = parse(z.object({ documentId: UuidSchema }), request.params, 'document id');
      const result = await container.transactions.withTenant(
        tenant.organizationId,
        async (scope) => {
          const document = await container.documents.repository.findById(
            scope,
            params.documentId as never,
          );
          if (document === undefined) return undefined;
          const texts = await container.documents.texts.listByDocument(scope, document.id);
          const children = await container.documents.repository.listChildren(scope, document.id);
          return { document, texts, children };
        },
      );
      if (result === undefined) {
        throw new NotFoundError('DOCUMENT_NOT_FOUND', 'The document was not found.');
      }
      return result;
    });
  };
}
