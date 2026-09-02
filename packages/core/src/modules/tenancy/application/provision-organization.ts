import { z } from 'zod';

import {
  ConflictError,
  type ValidationError,
  isDomainError,
  validationErrorFromZod,
} from '../../../kernel/errors.js';
import { ActorType } from '../../../kernel/context.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import type { TransactionRunner } from '../../../kernel/scope.js';
import type { AuditRecorder } from '../../audit/index.js';
import { type Membership } from '../domain/membership.js';
import { NewOrganizationSchema, type Organization } from '../domain/organization.js';
import { NewUserSchema, type User } from '../domain/user.js';
import type { MembershipRepository, OrganizationRepository, UserRepository } from './ports.js';

/**
 * Creates a tenant together with its first owner. Runs in system scope because
 * no tenant exists yet; the owner is provisioned just-in-time from their
 * identity-provider subject when unknown.
 */
export const ProvisionOrganizationInputSchema = z
  .object({
    organization: NewOrganizationSchema,
    owner: NewUserSchema,
  })
  .strict();
export type ProvisionOrganizationInput = z.input<typeof ProvisionOrganizationInputSchema>;

export interface ProvisionedOrganization {
  readonly organization: Organization;
  readonly owner: User;
  readonly membership: Membership;
}

export interface ProvisionOrganizationDependencies {
  readonly transactions: TransactionRunner;
  readonly organizations: OrganizationRepository;
  readonly users: UserRepository;
  readonly memberships: MembershipRepository;
  readonly audit: AuditRecorder;
}

export class ProvisionOrganization {
  private readonly deps: ProvisionOrganizationDependencies;

  constructor(deps: ProvisionOrganizationDependencies) {
    this.deps = deps;
  }

  async execute(
    rawInput: ProvisionOrganizationInput,
  ): Promise<Result<ProvisionedOrganization, ValidationError | ConflictError>> {
    const parsed = ProvisionOrganizationInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return err(
        validationErrorFromZod(
          parsed.error,
          'INVALID_ORGANIZATION',
          'The organization is invalid.',
        ),
      );
    }
    const input = parsed.data;

    try {
      return await this.deps.transactions.withSystemScope(
        'provision_organization',
        async (scope) => {
          const existing = await this.deps.organizations.findBySlug(scope, input.organization.slug);
          if (existing !== undefined) {
            return err(
              new ConflictError(
                'ORGANIZATION_SLUG_TAKEN',
                'An organization with this slug exists.',
                {
                  details: { slug: input.organization.slug },
                },
              ),
            );
          }
          const owner =
            (await this.deps.users.findByAuthSubject(scope, input.owner.authSubject)) ??
            (await this.deps.users.insert(scope, input.owner));
          const organization = await this.deps.organizations.insert(scope, input.organization);
          const membership = await this.deps.memberships.insert(scope, {
            organizationId: organization.id,
            userId: owner.id,
            roleKey: 'owner',
          });
          await this.deps.audit.record(scope, {
            organizationId: organization.id,
            actor: { type: ActorType.USER, id: owner.id },
            action: 'organization.provisioned',
            target: { type: 'organization', id: organization.id },
            details: { slug: organization.slug, ownerUserId: owner.id },
          });
          return ok({ organization, owner, membership });
        },
      );
    } catch (error) {
      // A concurrent provisioning of the same slug surfaces as a unique violation.
      if (isDomainError(error) && error instanceof ConflictError) {
        return err(
          new ConflictError('ORGANIZATION_SLUG_TAKEN', 'An organization with this slug exists.', {
            details: { slug: input.organization.slug },
            cause: error,
          }),
        );
      }
      throw error;
    }
  }
}
