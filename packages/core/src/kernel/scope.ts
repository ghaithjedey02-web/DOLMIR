import type { OrganizationId } from './ids.js';

/**
 * Data access happens inside a scope (ADR-0005).
 *
 * A `TenantScope` is a transaction in which the database only shows and
 * accepts rows of one organisation (Row-Level Security enforces it). A
 * `SystemScope` is the explicit, rare, logged path for operations that have
 * no tenant yet (provisioning an organisation, listing a user's memberships).
 * Repositories take the scope as their first argument; application code never
 * touches a connection.
 */
export interface TenantScope {
  readonly kind: 'tenant';
  readonly tenantId: OrganizationId;
}

export interface SystemScope {
  readonly kind: 'system';
  /** Why system scope was needed — logged, and audited once the audit module exists. */
  readonly reason: string;
}

export type Scope = TenantScope | SystemScope;

export interface TransactionRunner {
  withTenant<T>(tenantId: OrganizationId, fn: (scope: TenantScope) => Promise<T>): Promise<T>;
  withSystemScope<T>(reason: string, fn: (scope: SystemScope) => Promise<T>): Promise<T>;
}
