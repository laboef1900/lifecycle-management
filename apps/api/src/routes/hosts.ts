import type { FastifyPluginAsync } from 'fastify';

import {
  capacityRowInputSchema,
  clusterIdHostsParamsSchema,
  hostCreateInputSchema,
  hostIdParamsSchema,
  hostUpdateInputSchema,
} from '../schemas/host.js';
import { HostsService } from '../services/hosts.js';

export const hostRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new HostsService(fastify.prisma);

  fastify.get('/clusters/:clusterId/hosts', async (request) => {
    const { clusterId } = clusterIdHostsParamsSchema.parse(request.params);
    return service.listByCluster(request.tenantId, clusterId);
  });

  fastify.post('/clusters/:clusterId/hosts', async (request, reply) => {
    const { clusterId } = clusterIdHostsParamsSchema.parse(request.params);
    const input = hostCreateInputSchema.parse(request.body);
    const created = await service.create(request.tenantId, clusterId, input);
    reply.status(201);
    return created;
  });

  fastify.get('/hosts/:id', async (request) => {
    const { id } = hostIdParamsSchema.parse(request.params);
    return service.getById(request.tenantId, id);
  });

  fastify.put('/hosts/:id', async (request) => {
    const { id } = hostIdParamsSchema.parse(request.params);
    const input = hostUpdateInputSchema.parse(request.body);
    return service.update(request.tenantId, id, input);
  });

  fastify.post('/hosts/:id/capacity', async (request, reply) => {
    const { id } = hostIdParamsSchema.parse(request.params);
    const input = capacityRowInputSchema.parse(request.body);
    const updated = await service.appendCapacity(request.tenantId, id, input);
    reply.status(201);
    return updated;
  });

  fastify.delete('/hosts/:id', async (request, reply) => {
    const { id } = hostIdParamsSchema.parse(request.params);
    await service.delete(request.tenantId, id);
    reply.status(204);
    return null;
  });
};
