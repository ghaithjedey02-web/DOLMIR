import type { OrganizationId, UserId } from '../../../kernel/ids.js';
import type { Scope } from '../../../kernel/scope.js';
import type { Membership, NewMembership } from '../domain/membership.js';
import type { NewOrganization, Organization } from '../domain/organization.js';
import type { NewUser, User } from '../domain/user.js';

/**
 * Repository ports owned by the application layer (Dependency Inversion).
 * Every method takes the `Scope` it must operate in; the PostgreSQL adapters
 * bind it to the transaction, the in-memory adapters emulate the same
 * visibility rules so use cases are tested against identical semantics.
 *
 * Repositories throw `DomainError`s for infrastructure failures and for
 * constraint violations (translated at the boundary); they return `undefined`
 * for "not found" because absence is a normal answer, not a failure.
 */
export interface OrganizationRepository {
  findById(scope: Scope, id: OrganizationId): Promise<Organization | undefined>;
  findBySlug(scope: Scope, slug: string): Promise<Organization | undefined>;
  insert(scope: Scope, organization: NewOrganization): Promise<Organization>;
}

export interface UserRepository {
  findById(scope: Scope, id: UserId): Promise<User | undefined>;
  findByAuthSubject(scope: Scope, authSubject: string): Promise<User | undefined>;
  insert(scope: Scope, user: NewUser): Promise<User>;
}

export interface MembershipRepository {
  find(
    scope: Scope,
    organizationId: OrganizationId,
    userId: UserId,
  ): Promise<Membership | undefined>;
  listForUser(scope: Scope, userId: UserId): Promise<Membership[]>;
  insert(scope: Scope, membership: NewMembership): Promise<Membership>;
}
