import type { FastifyInstance } from 'fastify';

import { UnauthenticatedError } from '@dolmir/core';

import type { Container } from '../../composition/container.js';

/** Who am I, and where can I work. */
export function meRoutes(container: Container): (app: FastifyInstance) => Promise<void> {
  return async (app) => {
    app.get('/me', async (request) => {
      const principal = request.dolmir.principal;
      if (principal === undefined) {
        throw new UnauthenticatedError('MISSING_TOKEN', 'A bearer token is required.');
      }
      const organizations = await container.tenancy.listUserOrganizations.execute({
        authSubject: principal.subject,
      });
      return {
        principal: {
          subject: principal.subject,
          issuer: principal.issuer,
          email: principal.email ?? null,
          displayName: principal.displayName ?? null,
          expiresAt: principal.expiresAt,
        },
        organizations: organizations.map(({ organization, membership }) => ({
          id: organization.id,
          slug: organization.slug,
          name: organization.name,
          status: organization.status,
          roleKey: membership.roleKey,
        })),
      };
    });
  };
}
