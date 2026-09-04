import { ConflictError, ForbiddenError } from '../../../../kernel/errors.js';
import {
  newOrganizationId,
  newUserId,
  type OrganizationId,
  type UserId,
} from '../../../../kernel/ids.js';
import type { Scope } from '../../../../kernel/scope.js';
import type { Clock } from '../../../../kernel/clock.js';
import { systemClock } from '../../../../kernel/clock.js';
import type {
  MembershipRepository,
  OrganizationRepository,
  UserRepository,
} from '../../application/ports.js';
import type { Membership, NewMembership } from '../../domain/membership.js';
import type { NewOrganization, Organization } from '../../domain/organization.js';
import type { NewUser, User } from '../../domain/user.js';

/**
 * In-memory adapters that emulate the database's visibility rules exactly:
 * tenant scope sees only its organisation, its memberships and its members;
 * system scope sees everything; users are written in system scope only.
 * Use-case tests therefore exercise the same semantics as production.
 */
export class InMemoryTenancyStore {
  readonly organizations = new Map<OrganizationId, Organization>();
  readonly users = new Map<UserId, User>();
  readonly memberships: Membership[] = [];
  readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  isMember(userId: UserId, organizationId: OrganizationId): boolean {
    return this.memberships.some((m) => m.userId === userId && m.organizationId === organizationId);
  }
}

const visible = (scope: Scope, organizationId: OrganizationId): boolean =>
  scope.kind === 'system' || scope.tenantId === organizationId;

export class InMemoryOrganizationRepository implements OrganizationRepository {
  private readonly store: InMemoryTenancyStore;

  constructor(store: InMemoryTenancyStore) {
    this.store = store;
  }

  async findById(scope: Scope, id: OrganizationId): Promise<Organization | undefined> {
    const organization = this.store.organizations.get(id);
    return organization !== undefined && visible(scope, organization.id) ? organization : undefined;
  }

  async findBySlug(scope: Scope, slug: string): Promise<Organization | undefined> {
    for (const organization of this.store.organizations.values()) {
      if (organization.slug === slug && visible(scope, organization.id)) return organization;
    }
    return undefined;
  }

  async insert(scope: Scope, input: NewOrganization): Promise<Organization> {
    if (scope.kind !== 'system') {
      throw new ForbiddenError(
        'DATABASE_ACCESS_DENIED',
        'Organizations are created in system scope.',
      );
    }
    for (const existing of this.store.organizations.values()) {
      if (existing.slug === input.slug) {
        throw new ConflictError('UNIQUE_VIOLATION', 'A record with the same key already exists.');
      }
    }
    const now = this.store.clock.now();
    const organization: Organization = {
      id: newOrganizationId(),
      slug: input.slug,
      name: input.name,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.store.organizations.set(organization.id, organization);
    return organization;
  }
}

export class InMemoryUserRepository implements UserRepository {
  private readonly store: InMemoryTenancyStore;

  constructor(store: InMemoryTenancyStore) {
    this.store = store;
  }

  async findById(scope: Scope, id: UserId): Promise<User | undefined> {
    const user = this.store.users.get(id);
    return user !== undefined && this.visibleUser(scope, user) ? user : undefined;
  }

  async findByAuthSubject(scope: Scope, authSubject: string): Promise<User | undefined> {
    for (const user of this.store.users.values()) {
      if (user.authSubject === authSubject) {
        return this.visibleUser(scope, user) ? user : undefined;
      }
    }
    return undefined;
  }

  async insert(scope: Scope, input: NewUser): Promise<User> {
    if (scope.kind !== 'system') {
      throw new ForbiddenError('DATABASE_ACCESS_DENIED', 'Users are created in system scope.');
    }
    for (const existing of this.store.users.values()) {
      if (
        existing.authSubject === input.authSubject ||
        (input.email !== null && existing.email === input.email)
      ) {
        throw new ConflictError('UNIQUE_VIOLATION', 'A record with the same key already exists.');
      }
    }
    const now = this.store.clock.now();
    const user: User = {
      id: newUserId(),
      authSubject: input.authSubject,
      email: input.email,
      displayName: input.displayName,
      createdAt: now,
      updatedAt: now,
    };
    this.store.users.set(user.id, user);
    return user;
  }

  private visibleUser(scope: Scope, user: User): boolean {
    return scope.kind === 'system' || this.store.isMember(user.id, scope.tenantId);
  }
}

export class InMemoryMembershipRepository implements MembershipRepository {
  private readonly store: InMemoryTenancyStore;

  constructor(store: InMemoryTenancyStore) {
    this.store = store;
  }

  async find(
    scope: Scope,
    organizationId: OrganizationId,
    userId: UserId,
  ): Promise<Membership | undefined> {
    if (!visible(scope, organizationId)) return undefined;
    return this.store.memberships.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    );
  }

  async listForUser(scope: Scope, userId: UserId): Promise<Membership[]> {
    return this.store.memberships.filter(
      (m) => m.userId === userId && visible(scope, m.organizationId),
    );
  }

  async insert(scope: Scope, input: NewMembership): Promise<Membership> {
    if (!visible(scope, input.organizationId)) {
      throw new ForbiddenError('DATABASE_ACCESS_DENIED', 'Row-level security refused the insert.');
    }
    if (this.store.isMember(input.userId, input.organizationId)) {
      throw new ConflictError('UNIQUE_VIOLATION', 'A record with the same key already exists.');
    }
    const now = this.store.clock.now();
    const membership: Membership = {
      organizationId: input.organizationId,
      userId: input.userId,
      roleKey: input.roleKey,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.store.memberships.push(membership);
    return membership;
  }
}

/** A `TransactionRunner` for in-memory adapters: no transactions, just scopes. */
export class InMemoryTransactionRunner {
  readonly systemScopeReasons: string[] = [];
  /**
   * Run when a scope ends, whether it succeeded or not. A test double that
   * models a row lock releases it here, as committing or rolling back does.
   */
  readonly onScopeClosed: (() => void)[] = [];

  async withTenant<T>(
    tenantId: OrganizationId,
    fn: (scope: { kind: 'tenant'; tenantId: OrganizationId }) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn({ kind: 'tenant', tenantId });
    } finally {
      for (const closed of this.onScopeClosed) closed();
    }
  }

  async withSystemScope<T>(
    reason: string,
    fn: (scope: { kind: 'system'; reason: string }) => Promise<T>,
  ): Promise<T> {
    this.systemScopeReasons.push(reason);
    try {
      return await fn({ kind: 'system', reason });
    } finally {
      for (const closed of this.onScopeClosed) closed();
    }
  }
}
