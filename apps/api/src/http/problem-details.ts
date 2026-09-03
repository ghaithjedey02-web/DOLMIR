import { type DomainError, ErrorCategory } from '@dolmir/core';

/**
 * RFC 9457 problem details: the one error shape the API returns. Domain
 * errors map by category; details travel only for client-side categories,
 * never for infrastructure or internal failures (plan §R, Directive §18).
 */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: string;
  readonly requestId?: string;
  readonly retryable?: boolean;
  readonly errors?: unknown;
}

export const PROBLEM_TYPE_PREFIX = 'urn:dolmir:problem:';

const STATUS_BY_CATEGORY: Readonly<Record<ErrorCategory, number>> = {
  [ErrorCategory.VALIDATION]: 400,
  [ErrorCategory.UNAUTHENTICATED]: 401,
  [ErrorCategory.FORBIDDEN]: 403,
  [ErrorCategory.NOT_FOUND]: 404,
  [ErrorCategory.CONFLICT]: 409,
  [ErrorCategory.PRECONDITION_FAILED]: 412,
  [ErrorCategory.RATE_LIMITED]: 429,
  [ErrorCategory.INFRASTRUCTURE]: 503,
  [ErrorCategory.INTERNAL]: 500,
};

const TITLE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const CLIENT_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  ErrorCategory.VALIDATION,
  ErrorCategory.UNAUTHENTICATED,
  ErrorCategory.FORBIDDEN,
  ErrorCategory.NOT_FOUND,
  ErrorCategory.CONFLICT,
  ErrorCategory.PRECONDITION_FAILED,
  ErrorCategory.RATE_LIMITED,
]);

export function statusForCategory(category: ErrorCategory): number {
  return STATUS_BY_CATEGORY[category];
}

export function problemFromDomainError(
  error: DomainError,
  instance: string,
  requestId?: string,
): ProblemDetails {
  const status = statusForCategory(error.category);
  const isClient = CLIENT_CATEGORIES.has(error.category);
  return {
    type: `${PROBLEM_TYPE_PREFIX}${error.code.toLowerCase()}`,
    title: TITLE_BY_STATUS[status] ?? 'Error',
    status,
    detail: isClient ? error.message : 'The request could not be completed.',
    instance,
    code: isClient
      ? error.code
      : error.category === ErrorCategory.INFRASTRUCTURE
        ? 'SERVICE_UNAVAILABLE'
        : 'INTERNAL_ERROR',
    ...(requestId === undefined ? {} : { requestId }),
    ...(error.retryable ? { retryable: true } : {}),
    ...(isClient && Object.keys(error.details).length > 0 ? { errors: error.details } : {}),
  };
}

export function problemFromStatus(
  status: number,
  code: string,
  detail: string,
  instance: string,
  requestId?: string,
): ProblemDetails {
  return {
    type: `${PROBLEM_TYPE_PREFIX}${code.toLowerCase()}`,
    title: TITLE_BY_STATUS[status] ?? 'Error',
    status,
    detail,
    instance,
    code,
    ...(requestId === undefined ? {} : { requestId }),
  };
}
