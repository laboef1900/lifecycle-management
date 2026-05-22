import type { FastifyPluginAsync } from 'fastify';

import {
  clusterCreateInputSchema,
  clusterIdParamsSchema,
  clusterUpdateInputSchema,
} from '@lcm/shared';

import { ClustersService } from '../services/clusters.js';

export const clusterRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new ClustersService(fastify.prisma);

  fastify.get('/clusters', async (request) => {
    return service.list(request.tenantId);
  });

  fastify.get('/clusters/:id', async (request) => {
    const { id } = clusterIdParamsSchema.parse(request.params);
    return service.getById(request.tenantId, id);
  });

  fastify.post('/clusters', async (request, reply) => {
    const input = clusterCreateInputSchema.parse(request.body);
    const created = await service.create(request.tenantId, input);
    reply.status(201);
    return created;
  });

  fastify.put('/clusters/:id', async (request) => {
    const { id } = clusterIdParamsSchema.parse(request.params);
    const input = clusterUpdateInputSchema.parse(request.body);
    return service.update(request.tenantId, id, input);
  });

  fastify.delete('/clusters/:id', async (request, reply) => {
    const { id } = clusterIdParamsSchema.parse(request.params);
    await service.delete(request.tenantId, id);
    reply.status(204);
    return null;
  });
};
