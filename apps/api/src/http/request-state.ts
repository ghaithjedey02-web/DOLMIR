import type { ExecutionContext, TenantContext, UserPrincipal } from '@dolmir/core';

/**
 * What the platform knows about a request as it moves through the hooks:
 * the execution context from the first hook, the principal after
 * authentication, the tenant after membership resolution. Routes read it;
 * only hooks write it.
 */
export interface RequestState {
  context: ExecutionContext;
  principal?: UserPrincipal;
  tenant?: TenantContext;
}

declare module 'fastify' {
  interface FastifyRequest {
    dolmir: RequestState;
  }
}
