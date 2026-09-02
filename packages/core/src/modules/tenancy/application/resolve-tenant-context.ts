import { ForbiddenError } from '../../../kernel/errors.js';
import type { OrganizationId } from '../../../kernel/ids.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import type { TransactionRunner } from '../../../kernel/scope.js';
import type { TenantContext } from '../../../kernel/tenant.js';
import type { MembershipRepository, OrganizationRepository, UserRepository } from './ports.js';

/**
 * Turns an authenticated subject plus the organisation named in the request
 * into a `TenantContext`, or refuses.
 *
 * It deliberately runs *inside the requested tenant's scope*: Row-Level
 * Security only reveals the user and membership rows if the subject really is
 * a member, so the check and the isolation are the same mechanism, and system
 * scope is not needed on the hottest path. Nothing is returned to the caller
 * before the membership is confirmed.
 *
 * Every refusal is the same `NOT_A_MEMBER` error: the existence of an
 * organisation is not disclosed to outsiders.
 */
export interface ResolveTenantContextDependencies {
  readonly transactions: TransactionRunner;
  readonly organizations: OrganizationRepository;
  readonly users: UserRepository;
  readonly memberships: MembershipRepository;
}

export class ResolveTenantContext {
  private readonly deps: ResolveTenantContextDependencies;

  constructor(deps: ResolveTenantContextDependencies) {
    this.deps = deps;
  }

  async execute(input: {
    readonly authSubject: string;
    readonly organizationId: OrganizationId;
  }): Promise<Result<TenantContext, ForbiddenError>> {
    const refused = (): Result<TenantContext, ForbiddenError> =>
      err(
        new ForbiddenError('NOT_A_MEMBER', 'You are not a member of this organization.', {
          details: { organizationId: input.organizationId },
        }),
      );

    return this.deps.transactions.withTenant(input.organizationId, async (scope) => {
      const user = await this.deps.users.findByAuthSubject(scope, input.authSubject);
      if (user === undefined) return refused();

      const membership = await this.deps.memberships.find(scope, input.organizationId, user.id);
      if (membership?.status !== 'active') return refused();

      const organization = await this.deps.organizations.findById(scope, input.organizationId);
      if (organization === undefined) return refused();
      if (organization.status !== 'active') {
        return err(
          new ForbiddenError('ORGANIZATION_SUSPENDED', 'This organization is suspended.', {
            details: { organizationId: input.organizationId },
          }),
        );
      }

      return ok({
        organizationId: organization.id,
        organizationSlug: organization.slug,
        userId: user.id,
        roleKey: membership.roleKey,
      });
    });
  }
}
