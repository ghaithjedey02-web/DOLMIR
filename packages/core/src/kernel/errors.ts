import type { ZodError } from 'zod';

/**
 * The failure vocabulary of the platform.
 *
 * Two kinds of failure exist (plan §R, Trader OS Core Architecture §16):
 * expected domain failures travel as values (`Result`); infrastructure failures
 * are exceptions translated at adapter boundaries. Both are expressed as
 * `DomainError` so delivery layers can map them uniformly (RFC 9457 problem
 * details in HTTP) without ever leaking vendor exceptions, stack traces or
 * secrets to a caller.
 */

export const ErrorCategory = {
  VALIDATION: 'validation',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  PRECONDITION_FAILED: 'precondition_failed',
  RATE_LIMITED: 'rate_limited',
  INFRASTRUCTURE: 'infrastructure',
  INTERNAL: 'internal',
} as const;

export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

export type ErrorDetails = Readonly<Record<string, unknown>>;

export interface DomainErrorOptions {
  readonly details?: ErrorDetails;
  readonly cause?: unknown;
  readonly retryable?: boolean;
}

/** Shape safe to log and to serialise: no stack, no cause, no secrets. */
export interface DomainErrorRecord {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly details: ErrorDetails;
  readonly retryable: boolean;
}

export class DomainError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly details: ErrorDetails;
  readonly retryable: boolean;

  constructor(
    category: ErrorCategory,
    code: string,
    message: string,
    options: DomainErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.category = category;
    this.code = code;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
  }

  toRecord(): DomainErrorRecord {
    return {
      category: this.category,
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

export class ValidationError extends DomainError {
  constructor(code: string, message: string, options: DomainErrorOptions = {}) {
    super(ErrorCategory.VALIDATION, code, message, options);
  }
}

export class NotFoundError extends DomainError {
  constructor(code: string, message: string, options: DomainErrorOptions = {}) {
    super(ErrorCategory.NOT_FOUND, code, message, options);
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string, options: DomainErrorOptions = {}) {
    super(ErrorCategory.CONFLICT, code, message, options);
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(code: string, message: string, options: DomainErrorOptions = {}) {
    super(ErrorCategory.UNAUTHENTICATED, code, message, options);
  }
}

export class ForbiddenError extends DomainError {
  constructor(code: string, message: string, options: DomainErrorOptions = {}) {
    super(ErrorCategory.FORBIDDEN, code, message, options);
  }
}

export class PreconditionFailedError extends DomainError {
  constructor(code: string, message: string, options: DomainErrorOptions = {}) {
    super(ErrorCategory.PRECONDITION_FAILED, code, message, options);
  }
}

export class RateLimitedError extends DomainError {
  constructor(code: string, message: string, options: DomainErrorOptions = {}) {
    super(ErrorCategory.RATE_LIMITED, code, message, { retryable: true, ...options });
  }
}

export class InfrastructureError extends DomainError {
  constructor(code: string, message: string, options: DomainErrorOptions = {}) {
    super(ErrorCategory.INFRASTRUCTURE, code, message, options);
  }
}

export class InternalError extends DomainError {
  constructor(code: string, message: string, options: DomainErrorOptions = {}) {
    super(ErrorCategory.INTERNAL, code, message, options);
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

/**
 * Wraps anything thrown into a `DomainError` without exposing its message to
 * callers by default: unknown failures are internal until proven otherwise.
 */
export function toDomainError(value: unknown, code = 'UNEXPECTED_ERROR'): DomainError {
  if (isDomainError(value)) return value;
  return new InternalError(code, 'An unexpected error occurred.', { cause: value });
}

/** Translates a Zod failure into a `ValidationError` carrying each issue. */
export function validationErrorFromZod(
  error: ZodError,
  code = 'VALIDATION_FAILED',
  message = 'The input did not match the expected shape.',
): ValidationError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: issue.code,
    message: issue.message,
  }));
  return new ValidationError(code, message, { details: { issues } });
}
