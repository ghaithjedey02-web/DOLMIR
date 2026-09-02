import type { UnauthenticatedError } from '../../../kernel/errors.js';
import type { Result } from '../../../kernel/result.js';
import type { UserPrincipal } from '../domain/principal.js';

/**
 * Verifies a bearer token and yields the principal it represents. Failure is
 * a value: an invalid, expired or foreign token is an expected outcome at the
 * edge, not an exception. The reason is recorded in the error details for
 * logs; the token itself never is.
 */
export interface TokenVerifier {
  verify(token: string): Promise<Result<UserPrincipal, UnauthenticatedError>>;
}
