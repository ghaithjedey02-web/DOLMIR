import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Container, buildApp, createContainer } from '@dolmir/api';
import {
  type OrganizationId,
  type UserId,
  loadConfig,
  noopLogger,
  newRequestId,
} from '@dolmir/core';
import { createTestDatabase, type TestDatabase } from '../support/postgres-harness.js';

/**
 * The HTTP application end to end against a real PostgreSQL: configuration →
 * container → Fastify, with injected requests. Proves the plan §T items
 * "API boots, health endpoints respond, /v1/me and a tenant-scoped route work
 * end-to-end", plus the error contract (RFC 9457) and request correlation.
 */
describe('HTTP API (e2e)', () => {
  let db: TestDatabase;
  let container: Container;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgA: OrganizationId;
  let orgB: OrganizationId;
  let viewerUserId: UserId;
  let ownerToken: string;
  let viewerToken: string;
  let outsiderToken: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    const config = loadConfig({
      DOLMIR_ENV: 'test',
      DOLMIR_DATABASE_URL: db.appUrl,
      DOLMIR_DATABASE_OWNER_URL: db.ownerUrl,
      DOLMIR_AUTH_ISSUER: 'https://dolmir.test/auth',
      DOLMIR_AUTH_AUDIENCE: 'dolmir',
      DOLMIR_AUTH_HS256_SECRET: 'test-only-secret-that-is-long-enough-for-hs256-use',
      DOLMIR_STORAGE_DRIVER: 'memory',
      DOLMIR_AI_PROVIDER: 'fake',
    });
    if (!config.ok) throw config.error;
    container = createContainer(config.value, { logger: noopLogger });
    app = await buildApp(container);
    await app.ready();

    const a = await container.tenancy.provision.execute({
      organization: { slug: 'officina-a', name: 'Officina A' },
      owner: { authSubject: 'auth|owner-a', email: 'owner-a@example.test' },
    });
    const b = await container.tenancy.provision.execute({
      organization: { slug: 'officina-b', name: 'Officina B' },
      owner: { authSubject: 'auth|owner-b' },
    });
    if (!a.ok || !b.ok) throw new Error('provisioning failed');
    orgA = a.value.organization.id;
    orgB = b.value.organization.id;

    // A viewer in A: created in system scope, then made a member of A.
    const viewer = await container.transactions.withSystemScope('test: create viewer', (scope) =>
      container.repositories.users.insert(scope, {
        authSubject: 'auth|viewer-a',
        email: null,
        displayName: null,
      }),
    );
    viewerUserId = viewer.id;
    await container.transactions.withTenant(orgA, (scope) =>
      container.repositories.memberships.insert(scope, {
        organizationId: orgA,
        userId: viewer.id,
        roleKey: 'viewer',
      }),
    );

    const issuer = container.identity.devTokenIssuer;
    if (issuer === undefined) throw new Error('dev token issuer expected in test env');
    ownerToken = await issuer.issue({ subject: 'auth|owner-a', email: 'owner-a@example.test' });
    viewerToken = await issuer.issue({ subject: 'auth|viewer-a' });
    outsiderToken = await issuer.issue({ subject: 'auth|nobody' });
  });

  afterAll(async () => {
    await app.close();
    await container.close();
    await db.drop();
  });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it('answers liveness and an honest readiness report', async () => {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: 'ok' });

    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ready',
      checks: {
        database: { status: 'ok', role: 'dolmir_app', bypassesRls: false },
        migrations: { status: 'ok', pending: [] },
        ai: { status: 'ok', provider: 'fake' },
      },
    });
  });

  it('rejects missing and invalid tokens with RFC 9457 problems and a challenge', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect(missing.headers['www-authenticate']).toBe('Bearer realm="dolmir"');
    expect(missing.json()).toMatchObject({
      status: 401,
      code: 'MISSING_TOKEN',
      type: 'urn:dolmir:problem:missing_token',
      instance: '/v1/me',
    });

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer('not-a-jwt'),
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('tells an authenticated user who they are and where they can work', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(ownerToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      principal: { subject: 'auth|owner-a', email: 'owner-a@example.test' },
      organizations: [{ id: orgA, slug: 'officina-a', roleKey: 'owner' }],
    });
    const nobody = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(outsiderToken),
    });
    expect(nobody.json()).toMatchObject({ organizations: [] });
  });

  it('serves a tenant route to members only and never discloses foreign organizations', async () => {
    const own = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgA}`,
      headers: bearer(ownerToken),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({
      organization: { id: orgA, slug: 'officina-a', status: 'active' },
      membership: { roleKey: 'owner' },
      roleMatrixVersion: 2,
    });
    expect(own.json<{ permissions: string[] }>().permissions).toContain('audit:read');

    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgB}`,
      headers: bearer(ownerToken),
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ code: 'NOT_A_MEMBER' });

    const malformed = await app.inject({
      method: 'GET',
      url: '/v1/orgs/not-a-uuid',
      headers: bearer(ownerToken),
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'INVALID_ID' });
  });

  it('enforces permissions per role on the audit listing', async () => {
    const asOwner = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgA}/audit?limit=10`,
      headers: bearer(ownerToken),
    });
    expect(asOwner.statusCode).toBe(200);
    const entries = asOwner.json<{ entries: { action: string }[] }>().entries;
    expect(entries.map((e) => e.action)).toContain('organization.provisioned');

    const asViewer = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgA}/audit`,
      headers: bearer(viewerToken),
    });
    expect(asViewer.statusCode).toBe(403);
    expect(asViewer.json()).toMatchObject({
      code: 'PERMISSION_DENIED',
      errors: { permission: 'audit:read', roleKey: 'viewer' },
    });

    const badQuery = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgA}/audit?limit=abc`,
      headers: bearer(ownerToken),
    });
    expect(badQuery.statusCode).toBe(400);
    expect(badQuery.json()).toMatchObject({ code: 'INVALID_QUERY' });
  });

  it('reports AI usage per tenant after a recorded call', async () => {
    const fake = container.ai.provider;
    const call = await fake.complete({
      tenantId: orgA,
      tier: 'fast',
      operation: 'classify_message',
      useCase: 'commercial_inbox',
      messages: [{ role: 'user', content: 'Preventivo per 250 flange.' }],
    });
    // The fake provider is unscripted in the container: the call fails honestly and is still recorded.
    expect(call.ok).toBe(false);

    const usage = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgA}/ai-usage`,
      headers: bearer(ownerToken),
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toMatchObject({
      summary: [{ useCase: 'commercial_inbox', calls: 1, unpricedCalls: 1 }],
      recent: [{ succeeded: false, errorKind: 'PROVIDER_NOT_CONFIGURED', provider: 'fake' }],
    });

    const otherTenant = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgB}/ai-usage`,
      headers: bearer(await container.identity.devTokenIssuer!.issue({ subject: 'auth|owner-b' })),
    });
    expect(otherTenant.json()).toMatchObject({ summary: [], recent: [] });
  });

  it('correlates requests: honours a valid x-request-id and replaces a bogus one', async () => {
    const supplied = newRequestId();
    const echoed = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': supplied, 'x-correlation-id': supplied },
    });
    expect(echoed.headers['x-request-id']).toBe(supplied);
    expect(echoed.headers['x-correlation-id']).toBe(supplied);

    const bogus = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'DROP TABLE users' },
    });
    expect(bogus.headers['x-request-id']).not.toBe('DROP TABLE users');
    expect(String(bogus.headers['x-request-id'])).toMatch(/^[0-9a-f-]{36}$/);
    expect(bogus.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers unknown routes and malformed bodies as problems', async () => {
    const missing = await app.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'ROUTE_NOT_FOUND', status: 404 });

    const badJson = await app.inject({
      method: 'POST',
      url: '/v1/me',
      headers: { ...bearer(ownerToken), 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect([400, 404]).toContain(badJson.statusCode);
    expect(badJson.headers['content-type']).toContain('application/problem+json');
    expect(viewerUserId).toBeDefined();
  });
});
