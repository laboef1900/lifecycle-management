import type { FastifyPluginAsync } from 'fastify';

import {
  capacityRowInputSchema,
  clusterIdHostsParamsSchema,
  hostCreateInputSchema,
  hostIdParamsSchema,
  hostTransitionInputSchema,
  hostUpdateInputSchema,
} from '@lcm/shared';

import { HostLifecycleService } from '../services/host-lifecycle.js';
import { HostsService } from '../services/hosts.js';

export const hostRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new HostsService(fastify.prisma);
  const lifecycle = new HostLifecycleService(fastify.prisma);

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

  fastify.post('/hosts/:id/transitions', async (request, reply) => {
    const { id } = hostIdParamsSchema.parse(request.params);
    const input = hostTransitionInputSchema.parse(request.body);
    await lifecycle.transition({
      tenantId: request.tenantId,
      hostId: id,
      toState: input.toState,
      occurredAt: input.occurredAt,
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    reply.status(204);
    return null;
  });

  fastify.get('/hosts/:id/lifecycle', async (request) => {
    const { id } = hostIdParamsSchema.parse(request.params);
    return lifecycle.listEvents(request.tenantId, id);
  });
};
