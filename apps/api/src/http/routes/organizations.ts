import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  ForbiddenError,
  NotFoundError,
  Permission,
  ROLE_MATRIX_VERSION,
  validationErrorFromZod,
} from '@dolmir/core';

import type { Container } from '../../composition/container.js';
import { requirePermission } from '../hooks.js';

/**
 * Tenant-scoped routes under `/v1/orgs/:orgId`. The tenant hook has already
 * proven membership; every handler still names the permission it needs and
 * runs its queries inside `withTenant`, so Row-Level Security is the last
 * word on what is returned (ADR-0005).
 */
const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime().optional(),
  action: z
    .string()
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
    .optional(),
});

const UsageQuerySchema = z.object({
  since: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

function parseQuery<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw validationErrorFromZod(parsed.error, 'INVALID_QUERY', 'The query string is invalid.');
  }
  return parsed.data;
}

export function organizationRoutes(container: Container): (app: FastifyInstance) => Promise<void> {
  return async (app) => {
    app.get('/', async (request) => {
      const tenant = request.dolmir.tenant;
      if (tenant === undefined) throw new ForbiddenError('NO_TENANT_CONTEXT', 'No organization.');
      requirePermission(container, request, Permission.ORGANIZATION_READ);
      const organization = await container.transactions.withTenant(tenant.organizationId, (scope) =>
        container.repositories.organizations.findById(scope, tenant.organizationId),
      );
      if (organization === undefined) {
        throw new NotFoundError('ORGANIZATION_NOT_FOUND', 'The organization was not found.');
      }
      return {
        organization: {
          id: organization.id,
          slug: organization.slug,
          name: organization.name,
          status: organization.status,
          createdAt: organization.createdAt,
        },
        membership: { userId: tenant.userId, roleKey: tenant.roleKey },
        permissions: [...container.authorizer.permissionsFor(tenant.roleKey)].sort(),
        roleMatrixVersion: ROLE_MATRIX_VERSION,
      };
    });

    app.get('/audit', async (request) => {
      const tenant = request.dolmir.tenant;
      if (tenant === undefined) throw new ForbiddenError('NO_TENANT_CONTEXT', 'No organization.');
      requirePermission(container, request, Permission.AUDIT_READ);
      const query = parseQuery(AuditQuerySchema, request.query);
      const entries = await container.transactions.withTenant(tenant.organizationId, (scope) =>
        container.audit.list(scope, {
          limit: query.limit,
          ...(query.before === undefined ? {} : { before: new Date(query.before) }),
          ...(query.action === undefined ? {} : { action: query.action }),
        }),
      );
      return { entries };
    });

    app.get('/ai-usage', async (request) => {
      const tenant = request.dolmir.tenant;
      if (tenant === undefined) throw new ForbiddenError('NO_TENANT_CONTEXT', 'No organization.');
      requirePermission(container, request, Permission.AI_USAGE_READ);
      const query = parseQuery(UsageQuerySchema, request.query);
      const since = query.since === undefined ? undefined : new Date(query.since);
      const { summary, recent } = await container.transactions.withTenant(
        tenant.organizationId,
        async (scope) => ({
          summary: await container.ai.usage.summarize(scope, since === undefined ? {} : { since }),
          recent: await container.ai.usage.list(scope, { limit: query.limit }),
        }),
      );
      return { since: since ?? null, summary, recent };
    });
  };
}
