import pg from 'pg';

import {
  ConflictError,
  type DomainError,
  ForbiddenError,
  InfrastructureError,
  PreconditionFailedError,
  ValidationError,
  isDomainError,
} from '../../kernel/errors.js';

const { DatabaseError } = pg;

/**
 * Translates a driver failure into the platform's error vocabulary at the
 * adapter boundary (ADR-0003). Domain errors thrown inside a transaction pass
 * through untouched. Messages never include SQL text or parameter values.
 */
export function translatePgError(error: unknown): DomainError {
  if (isDomainError(error)) return error;

  if (error instanceof DatabaseError) {
    const code = error.code ?? '';
    const details = {
      sqlState: code,
      ...(error.constraint === undefined ? {} : { constraint: error.constraint }),
      ...(error.table === undefined ? {} : { table: error.table }),
    };
    switch (code) {
      case '23505':
        return new ConflictError('UNIQUE_VIOLATION', 'A record with the same key already exists.', {
          details,
          cause: error,
        });
      case '23503':
        return new PreconditionFailedError(
          'FOREIGN_KEY_VIOLATION',
          'The record references something that does not exist.',
          { details, cause: error },
        );
      case '23514':
        return new ValidationError(
          'CHECK_VIOLATION',
          'The record violates a database constraint.',
          {
            details,
            cause: error,
          },
        );
      case '23502':
        return new ValidationError('NOT_NULL_VIOLATION', 'A required value is missing.', {
          details,
          cause: error,
        });
      case '23000':
        return new ForbiddenError('APPEND_ONLY_VIOLATION', 'This record is append-only.', {
          details,
          cause: error,
        });
      case '42501':
        return new ForbiddenError(
          'DATABASE_ACCESS_DENIED',
          'The database refused the operation for the current scope.',
          { details, cause: error },
        );
      case '40001':
      case '40P01':
        return new InfrastructureError(
          'TRANSACTION_CONFLICT',
          'The transaction conflicted with another one; retry.',
          { details, cause: error, retryable: true },
        );
      case '57014':
        return new InfrastructureError('QUERY_CANCELED', 'The query was cancelled or timed out.', {
          details,
          cause: error,
          retryable: true,
        });
      default:
        if (code.startsWith('08')) {
          return new InfrastructureError(
            'DATABASE_UNAVAILABLE',
            'The database connection failed.',
            { details, cause: error, retryable: true },
          );
        }
        return new InfrastructureError('DATABASE_ERROR', 'The database operation failed.', {
          details,
          cause: error,
        });
    }
  }

  const errno = (error as { code?: unknown } | null)?.code;
  if (
    typeof errno === 'string' &&
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(errno)
  ) {
    return new InfrastructureError('DATABASE_UNAVAILABLE', 'The database is not reachable.', {
      details: { errno },
      cause: error,
      retryable: true,
    });
  }

  return new InfrastructureError('DATABASE_ERROR', 'The database operation failed.', {
    cause: error,
  });
}
