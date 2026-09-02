import type { TransactionRunner } from '../../../kernel/scope.js';
import type { Membership } from '../domain/membership.js';
import type { Organization } from '../domain/organization.js';
import type { MembershipRepository, OrganizationRepository, UserRepository } from './ports.js';

/**
 * The organisations a subject belongs to, for "who am I / where can I work".
 * Crosses tenants by nature, so it runs in system scope — read-only, with a
 * stated reason.
 */
export interface UserOrganization {
  readonly organization: Organization;
  readonly membership: Membership;
}

export interface ListUserOrganizationsDependencies {
  readonly transactions: TransactionRunner;
  readonly organizations: OrganizationRepository;
  readonly users: UserRepository;
  readonly memberships: MembershipRepository;
}

export class ListUserOrganizations {
  private readonly deps: ListUserOrganizationsDependencies;

  constructor(deps: ListUserOrganizationsDependencies) {
    this.deps = deps;
  }

  async execute(input: { readonly authSubject: string }): Promise<UserOrganization[]> {
    return this.deps.transactions.withSystemScope('list_user_organizations', async (scope) => {
      const user = await this.deps.users.findByAuthSubject(scope, input.authSubject);
      if (user === undefined) return [];
      const memberships = await this.deps.memberships.listForUser(scope, user.id);
      const result: UserOrganization[] = [];
      for (const membership of memberships) {
        if (membership.status !== 'active') continue;
        const organization = await this.deps.organizations.findById(
          scope,
          membership.organizationId,
        );
        if (organization !== undefined) result.push({ organization, membership });
      }
      return result;
    });
  }
}
