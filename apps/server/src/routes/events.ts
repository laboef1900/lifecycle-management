import type { FastifyPluginAsync } from 'fastify';

import {
  clusterIdEventsParamsSchema,
  eventCreateInputSchema,
  eventIdParamsSchema,
  eventUpdateInputSchema,
} from '@lcm/shared';

import { EventsService } from '../services/events.js';

export const eventRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new EventsService(fastify.prisma);

  fastify.get('/clusters/:clusterId/events', async (request) => {
    const { clusterId } = clusterIdEventsParamsSchema.parse(request.params);
    return service.listByCluster(request.tenantId, clusterId);
  });

  fastify.post('/clusters/:clusterId/events', async (request, reply) => {
    const { clusterId } = clusterIdEventsParamsSchema.parse(request.params);
    const input = eventCreateInputSchema.parse(request.body);
    const created = await service.create(request.tenantId, clusterId, input);
    reply.status(201);
    return created;
  });

  fastify.put('/events/:id', async (request) => {
    const { id } = eventIdParamsSchema.parse(request.params);
    const input = eventUpdateInputSchema.parse(request.body);
    return service.update(request.tenantId, id, input);
  });

  fastify.delete('/events/:id', async (request, reply) => {
    const { id } = eventIdParamsSchema.parse(request.params);
    await service.delete(request.tenantId, id);
    reply.status(204);
    return null;
  });
};
