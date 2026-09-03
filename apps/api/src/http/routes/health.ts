import type { FastifyInstance } from 'fastify';

import type { Container } from '../../composition/container.js';

/**
 * `live`: the process answers. `ready`: it can do useful work — database
 * reachable as a role that cannot bypass RLS, migrations current, AI provider
 * configured or explicitly not (plan §N). Readiness never lies: an unpriced
 * or unconfigured provider is reported, not hidden.
 */
export function healthRoutes(container: Container): (app: FastifyInstance) => Promise<void> {
  const startedAt = container.clock.now();
  return async (app) => {
    app.get('/health/live', async () => ({
      status: 'ok',
      uptimeSeconds: Math.round((container.clock.now().getTime() - startedAt.getTime()) / 1000),
    }));

    app.get('/health/ready', async (_request, reply) => {
      const report = await container.readiness();
      return reply.code(report.status === 'ready' ? 200 : 503).send(report);
    });
  };
}
