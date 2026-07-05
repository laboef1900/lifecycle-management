import type { FastifyPluginAsync } from 'fastify';

import type { ApiErrorBody } from '@lcm/shared';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/healthz', async () => ({ status: 'ok' }));

  fastify.get('/readyz', async (request, reply) => {
    try {
      await fastify.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch (err) {
      request.log.error({ err }, 'Readiness check failed');
      const body: ApiErrorBody = {
        error: {
          code: 'DEPENDENCY_UNHEALTHY',
          message: 'Database is unreachable',
        },
      };
      reply.status(503).send(body);
      return reply;
    }
  });
};
