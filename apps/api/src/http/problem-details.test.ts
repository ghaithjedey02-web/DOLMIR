import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  ForbiddenError,
  InfrastructureError,
  InternalError,
  NotFoundError,
  PreconditionFailedError,
  RateLimitedError,
  UnauthenticatedError,
  ValidationError,
} from '@dolmir/core';

import { problemFromDomainError, problemFromStatus } from './problem-details.js';

describe('problem details', () => {
  it('maps every client-side category to its status and keeps code, message and details', () => {
    const cases = [
      [new ValidationError('INVALID_QUERY', 'bad query', { details: { issues: [] } }), 400],
      [new UnauthenticatedError('TOKEN_EXPIRED', 'expired'), 401],
      [new ForbiddenError('PERMISSION_DENIED', 'no', { details: { permission: 'x' } }), 403],
      [new NotFoundError('ORGANIZATION_NOT_FOUND', 'missing'), 404],
      [new ConflictError('ORGANIZATION_SLUG_TAKEN', 'taken'), 409],
      [new PreconditionFailedError('MIGRATION_CHECKSUM_MISMATCH', 'edited'), 412],
      [new RateLimitedError('LLM_RATE_LIMITED', 'slow down'), 429],
    ] as const;
    for (const [error, status] of cases) {
      const problem = problemFromDomainError(error, '/v1/x', 'req-1');
      expect(problem.status).toBe(status);
      expect(problem.code).toBe(error.code);
      expect(problem.detail).toBe(error.message);
      expect(problem.type).toBe(`urn:dolmir:problem:${error.code.toLowerCase()}`);
      expect(problem.requestId).toBe('req-1');
      expect(problem.instance).toBe('/v1/x');
    }
    const forbidden = problemFromDomainError(
      new ForbiddenError('PERMISSION_DENIED', 'no', { details: { permission: 'x' } }),
      '/v1/x',
    );
    expect(forbidden.errors).toEqual({ permission: 'x' });
    expect(forbidden).not.toHaveProperty('requestId');
    const limited = problemFromDomainError(new RateLimitedError('LLM_RATE_LIMITED', 'x'), '/');
    expect(limited.retryable).toBe(true);
  });

  it('hides messages and details of infrastructure and internal failures', () => {
    const infra = problemFromDomainError(
      new InfrastructureError('DB_DOWN', 'connection refused to db.internal:5432', {
        details: { host: 'db.internal' },
      }),
      '/v1/x',
    );
    expect(infra).toMatchObject({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      detail: 'The request could not be completed.',
    });
    expect(infra).not.toHaveProperty('errors');
    const internal = problemFromDomainError(
      new InternalError('BUG', 'stack trace details here'),
      '/v1/x',
    );
    expect(internal).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
    expect(internal.detail).not.toContain('stack');
  });

  it('builds problems for framework statuses', () => {
    expect(problemFromStatus(404, 'ROUTE_NOT_FOUND', 'No route.', '/nope', 'r')).toEqual({
      type: 'urn:dolmir:problem:route_not_found',
      title: 'Not Found',
      status: 404,
      detail: 'No route.',
      instance: '/nope',
      code: 'ROUTE_NOT_FOUND',
      requestId: 'r',
    });
  });
});
