import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  ForbiddenError,
  Permission,
  entityRowsFromCsv,
  validationErrorFromZod,
} from '@dolmir/core';

import type { Container } from '../../composition/container.js';
import { requirePermission } from '../hooks.js';

/**
 * Company configuration, master data and connections: what a company sets up
 * before DOLMIR can do anything useful for it. Credentials go in and never
 * come out; an ingestion secret is shown once, at creation.
 */
const ProfileSchema = z
  .object({
    legalName: z.string().trim().min(1).max(300).optional(),
    sector: z.string().trim().min(1).max(200).nullable().optional(),
    description: z.string().trim().min(1).max(2000).nullable().optional(),
    languages: z.array(z.string().trim().min(2).max(5)).max(10).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    signature: z.string().trim().min(1).max(2000).nullable().optional(),
  })
  .strict();

const RuleSchema = z.object({
  value: z.unknown(),
  rationale: z.string().trim().max(2000).nullable().default(null),
});

const TermSchema = z.object({
  term: z.string().trim().min(1).max(200),
  meaning: z.string().trim().min(1).max(2000),
});

const PolicySchema = z.object({
  scope: z.enum(['tool', 'effect']),
  subject: z.string().trim().min(1).max(100),
  level: z.enum(['READ_ONLY', 'SUGGEST', 'DRAFT', 'REQUIRE_APPROVAL', 'AUTO_EXECUTE']).nullable(),
  rationale: z.string().trim().min(1).max(2000).optional(),
});

const ImportSchema = z.object({
  /** Semicolon or comma separated, with a header row. */
  csv: z.string().min(1).max(2_000_000),
  source: z.string().trim().min(1).max(200).default('api'),
});

const ConnectionSchema = z.object({
  capability: z.enum(['mailbox', 'ingest_endpoint']),
  provider: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
  displayName: z.string().trim().min(1).max(200),
  settings: z.record(z.string(), z.unknown()).default({}),
  credentials: z.record(z.string(), z.unknown()),
});

function parse<S extends z.ZodType>(schema: S, raw: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw validationErrorFromZod(parsed.error, 'INVALID_REQUEST', `The ${what} is invalid.`);
  }
  return parsed.data;
}

export function workspaceRoutes(container: Container): (app: FastifyInstance) => Promise<void> {
  return async (app) => {
    const tenantOf = (request: Parameters<typeof requirePermission>[1]) => {
      const tenant = request.dolmir.tenant;
      if (tenant === undefined) throw new ForbiddenError('NO_TENANT_CONTEXT', 'No organization.');
      return tenant;
    };

    app.get('/workspace', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.ORGANIZATION_READ);
      const context = await container.transactions.withTenant(tenant.organizationId, (scope) =>
        container.workspace.configuration.context(scope, tenant.organizationSlug),
      );
      return {
        ...context,
        knownRules: container.workspace.rules
          .list()
          .map((rule) => ({ key: rule.key, description: rule.description, owner: rule.owner })),
      };
    });

    app.patch('/workspace/profile', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.WORKSPACE_MANAGE);
      const patch = parse(ProfileSchema, request.body ?? {}, 'profile');
      const updated = await container.transactions.withTenant(tenant.organizationId, (scope) =>
        container.workspace.configuration.updateProfile(
          scope,
          tenant,
          patch,
          tenant.organizationSlug,
        ),
      );
      if (!updated.ok) throw updated.error;
      return { profile: updated.value };
    });

    app.put('/workspace/rules/:key', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.WORKSPACE_MANAGE);
      const params = parse(
        z.object({ key: z.string().min(1).max(120) }),
        request.params,
        'rule key',
      );
      const body = parse(RuleSchema, request.body ?? {}, 'rule');
      const saved = await container.transactions.withTenant(tenant.organizationId, (scope) =>
        container.workspace.configuration.setRule(
          scope,
          tenant,
          params.key,
          body.value,
          body.rationale,
        ),
      );
      if (!saved.ok) throw saved.error;
      return { rule: saved.value };
    });

    app.post('/workspace/terminology', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.WORKSPACE_MANAGE);
      const body = parse(TermSchema, request.body ?? {}, 'term');
      const saved = await container.transactions.withTenant(tenant.organizationId, (scope) =>
        container.workspace.configuration.upsertTerm(scope, tenant, body),
      );
      if (!saved.ok) throw saved.error;
      return { term: saved.value };
    });

    app.put('/workspace/policy', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.WORKSPACE_MANAGE);
      const body = parse(PolicySchema, request.body ?? {}, 'policy override');
      const saved = await container.transactions.withTenant(tenant.organizationId, (scope) =>
        container.workspace.configuration.setPolicyOverride(
          scope,
          tenant,
          body.scope,
          body.subject,
          body.level,
          body.rationale ?? 'set through the API',
        ),
      );
      if (!saved.ok) throw saved.error;
      return { override: saved.value };
    });

    app.post('/entities/import', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.ENTITIES_MANAGE);
      const body = parse(ImportSchema, request.body ?? {}, 'import');
      const parsedRows = entityRowsFromCsv(body.csv);
      if (!parsedRows.ok) throw parsedRows.error;
      // The use case validates each row against its own schema and reports the
      // first that does not fit, so a bad column never becomes a silent skip.
      const imported = await container.entities.import.execute(
        tenant.organizationId,
        { type: 'USER', id: tenant.userId },
        { rows: parsedRows.value as never, source: body.source },
      );
      if (!imported.ok) throw imported.error;
      return imported.value;
    });

    app.get('/connections', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.CONNECTIONS_READ);
      const listed = await container.connectors.manage.list(tenant, { limit: 100 });
      if (!listed.ok) throw listed.error;
      return { connections: listed.value };
    });

    app.post('/connections', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.CONNECTIONS_MANAGE);
      const body = parse(ConnectionSchema, request.body ?? {}, 'connection');
      const created = await container.connectors.manage.create(tenant, body);
      if (!created.ok) throw created.error;
      return { connection: created.value };
    });

    app.post('/connections/ingestion-keys', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.CONNECTIONS_MANAGE);
      const body = parse(
        z.object({ displayName: z.string().trim().min(1).max(200).default('ingestion key') }),
        request.body ?? {},
        'request body',
      );
      const issued = await container.connectors.manage.issueIngestionKey(tenant, body.displayName);
      if (!issued.ok) throw issued.error;
      // The only moment the secret exists outside the database. It is never recoverable.
      return issued.value;
    });

    app.post('/connections/:connectionId/status', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.CONNECTIONS_MANAGE);
      const params = parse(z.object({ connectionId: z.uuid() }), request.params, 'connection id');
      const body = parse(
        z.object({ status: z.enum(['active', 'disabled', 'error']) }),
        request.body ?? {},
        'request body',
      );
      const updated = await container.connectors.manage.setStatus(
        tenant,
        params.connectionId as never,
        body.status,
      );
      if (!updated.ok) throw updated.error;
      return { connection: updated.value };
    });

    app.post('/connections/:connectionId/poll', async (request) => {
      const tenant = tenantOf(request);
      requirePermission(container, request, Permission.CONNECTIONS_MANAGE);
      const params = parse(z.object({ connectionId: z.uuid() }), request.params, 'connection id');
      const report = await container.connectors.poll.execute(
        tenant.organizationId,
        params.connectionId as never,
      );
      if (!report.ok) throw report.error;
      return report.value;
    });
  };
}
