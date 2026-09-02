import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ErrorCategory,
  InternalError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
  isDomainError,
  toDomainError,
  validationErrorFromZod,
} from './errors.js';

describe('DomainError', () => {
  it('carries category, code, details and retryability', () => {
    const error = new NotFoundError('ORGANIZATION_NOT_FOUND', 'No such organization.', {
      details: { organizationId: 'abc' },
    });
    expect(error.name).toBe('NotFoundError');
    expect(error.category).toBe(ErrorCategory.NOT_FOUND);
    expect(error.code).toBe('ORGANIZATION_NOT_FOUND');
    expect(error.details).toEqual({ organizationId: 'abc' });
    expect(error.retryable).toBe(false);
    expect(new RateLimitedError('TOO_MANY', 'Slow down.').retryable).toBe(true);
  });

  it('serialises to a record without stack or cause', () => {
    const cause = new Error('vendor detail with secret sk-123');
    const error = new InternalError('BOOM', 'Something failed.', { cause });
    const record = error.toRecord();
    expect(record).toEqual({
      category: 'internal',
      code: 'BOOM',
      message: 'Something failed.',
      details: {},
      retryable: false,
    });
    expect(JSON.stringify(record)).not.toContain('sk-123');
    expect(error.cause).toBe(cause);
  });

  it('wraps unknown throwables as internal errors without leaking their message', () => {
    const wrapped = toDomainError(new TypeError('x is not a function'));
    expect(wrapped.category).toBe(ErrorCategory.INTERNAL);
    expect(wrapped.message).toBe('An unexpected error occurred.');
    expect(isDomainError(wrapped)).toBe(true);
    const passthrough = new ValidationError('V', 'v');
    expect(toDomainError(passthrough)).toBe(passthrough);
  });

  it('translates Zod issues into structured validation details', () => {
    const schema = z.object({ quantity: z.number().int().positive() });
    const parsed = schema.safeParse({ quantity: -1 });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const error = validationErrorFromZod(parsed.error);
    expect(error.category).toBe(ErrorCategory.VALIDATION);
    expect(error.details['issues']).toEqual([
      expect.objectContaining({ path: 'quantity', code: 'too_small' }),
    ]);
  });
});
