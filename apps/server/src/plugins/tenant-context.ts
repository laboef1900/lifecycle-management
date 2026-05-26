import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

export const DEFAULT_TENANT_ID = 'default';

const tenantContextPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('tenantId', '');

  fastify.addHook('onRequest', async (request) => {
    request.tenantId = DEFAULT_TENANT_ID;
  });
};

export default fp(tenantContextPlugin, { name: 'tenant-context' });
