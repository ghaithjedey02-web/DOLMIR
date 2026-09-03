import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

import {
  ActorType,
  CorrelationIdSchema,
  type ExecutionContext,
  ForbiddenError,
  OrganizationIdSchema,
  type Permission,
  RequestIdSchema,
  UnauthenticatedError,
  newCorrelationId,
  newRequestId,
  parseId,
  runWithContext,
  toDomainError,
} from '@dolmir/core';

import type { Container } from '../composition/container.js';
import './request-state.js';

/**
 * Hooks are written callback-style on purpose: `runWithContext(context, done)`
 * continues the rest of the request lifecycle inside the async-local store,
 * so logs, audit rows and usage rows written by route handlers carry the
 * request, correlation, tenant and actor ids without threading them through
 * every signature.
 */

/** Chooses the request id: a valid client-supplied `x-request-id` is honoured, anything else is replaced. */
export function generateRequestId(headers: Record<string, unknown>): string {
  const supplied = headers['x-request-id'];
  return typeof supplied === 'string' && RequestIdSchema.safeParse(supplied).success
    ? supplied
    : newRequestId();
}

export function contextHook(): (
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
) => void {
  return (request, reply, done) => {
    const requestId = RequestIdSchema.parse(request.id);
    const suppliedCorrelation = request.headers['x-correlation-id'];
    const correlationId =
      typeof suppliedCorrelation === 'string' &&
      CorrelationIdSchema.safeParse(suppliedCorrelation).success
        ? CorrelationIdSchema.parse(suppliedCorrelation)
        : newCorrelationId();
    const context: ExecutionContext = { requestId, correlationId };
    request.dolmir = { context };
    void reply.header('x-request-id', requestId);
    void reply.header('x-correlation-id', correlationId);
    runWithContext(context, done);
  };
}

/** Bearer authentication: a verified principal or an `UnauthenticatedError` for the error handler. */
export function authHook(
  container: Container,
): (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => void {
  return (request, _reply, done) => {
    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token.length === 0) {
      done(new UnauthenticatedError('MISSING_TOKEN', 'A bearer token is required.'));
      return;
    }
    container.identity.verifier.verify(token).then(
      (result) => {
        if (!result.ok) {
          done(result.error);
          return;
        }
        request.dolmir.principal = result.value;
        const context: ExecutionContext = {
          ...request.dolmir.context,
          actor: { type: ActorType.USER, id: result.value.subject },
        };
        request.dolmir.context = context;
        runWithContext(context, done);
      },
      (error: unknown) => {
        done(toDomainError(error));
      },
    );
  };
}

/** Resolves `:orgId` plus the principal into a `TenantContext`, or refuses. */
export function tenantHook(
  container: Container,
): (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => void {
  return (request, _reply, done) => {
    const principal = request.dolmir.principal;
    if (principal === undefined) {
      done(new UnauthenticatedError('MISSING_TOKEN', 'A bearer token is required.'));
      return;
    }
    const params = request.params as { orgId?: unknown };
    const organizationId = parseId(OrganizationIdSchema, params.orgId, 'orgId');
    if (!organizationId.ok) {
      done(organizationId.error);
      return;
    }
    container.tenancy.resolveTenant
      .execute({ authSubject: principal.subject, organizationId: organizationId.value })
      .then(
        (result) => {
          if (!result.ok) {
            done(result.error);
            return;
          }
          request.dolmir.tenant = result.value;
          const context: ExecutionContext = {
            ...request.dolmir.context,
            tenantId: result.value.organizationId,
            actor: { type: ActorType.USER, id: result.value.userId },
          };
          request.dolmir.context = context;
          runWithContext(context, done);
        },
        (error: unknown) => {
          done(toDomainError(error));
        },
      );
  };
}

/** Deterministic permission check for a tenant route; throws for the error handler. */
export function requirePermission(
  container: Container,
  request: FastifyRequest,
  permission: Permission,
): void {
  const tenant = request.dolmir.tenant;
  if (tenant === undefined) {
    throw new ForbiddenError('NO_TENANT_CONTEXT', 'This route requires an organization.');
  }
  const decision = container.authorizer.require(tenant, permission);
  if (!decision.ok) throw decision.error;
}
