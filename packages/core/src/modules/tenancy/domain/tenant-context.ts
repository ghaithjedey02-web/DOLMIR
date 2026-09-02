import type { OrganizationId, UserId } from '../../../kernel/ids.js';
import type { RoleKey } from './membership.js';

/**
 * The resolved answer to "who is acting, in which organisation, as what".
 * Produced once per request after authentication; every tenant-scoped use
 * case receives it and never re-derives it from client input.
 */
export interface TenantContext {
  readonly organizationId: OrganizationId;
  readonly organizationSlug: string;
  readonly userId: UserId;
  readonly roleKey: RoleKey;
}
