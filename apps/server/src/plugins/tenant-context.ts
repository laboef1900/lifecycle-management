import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

export const DEFAULT_TENANT_ID = 'default';

/**
 * Resolves the request tenant from the authenticated principal (auth plugin
 * runs first). v1 is single-tenant: every user row carries tenant 'default'.
 */
const tenantContextPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('tenantId', '');

  fastify.addHook('onRequest', async (request) => {
    request.tenantId = request.user?.tenantId ?? DEFAULT_TENANT_ID;
  });
};

export default fp(tenantContextPlugin, { name: 'tenant-context', dependencies: ['auth'] });
