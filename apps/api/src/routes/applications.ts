import type { FastifyPluginAsync } from 'fastify';

import {
  allocationRowInputSchema,
  applicationCreateInputSchema,
  applicationIdParamsSchema,
  applicationUpdateInputSchema,
  clusterIdApplicationsParamsSchema,
} from '@lcm/shared';

import { ApplicationsService } from '../services/applications.js';

export const applicationRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new ApplicationsService(fastify.prisma);

  fastify.get('/clusters/:clusterId/applications', async (request) => {
    const { clusterId } = clusterIdApplicationsParamsSchema.parse(request.params);
    return service.listByCluster(request.tenantId, clusterId);
  });

  fastify.post('/clusters/:clusterId/applications', async (request, reply) => {
    const { clusterId } = clusterIdApplicationsParamsSchema.parse(request.params);
    const input = applicationCreateInputSchema.parse(request.body);
    const created = await service.create(request.tenantId, clusterId, input);
    reply.status(201);
    return created;
  });

  fastify.get('/applications/:id', async (request) => {
    const { id } = applicationIdParamsSchema.parse(request.params);
    return service.getById(request.tenantId, id);
  });

  fastify.put('/applications/:id', async (request) => {
    const { id } = applicationIdParamsSchema.parse(request.params);
    const input = applicationUpdateInputSchema.parse(request.body);
    return service.update(request.tenantId, id, input);
  });

  fastify.post('/applications/:id/allocation', async (request, reply) => {
    const { id } = applicationIdParamsSchema.parse(request.params);
    const input = allocationRowInputSchema.parse(request.body);
    const updated = await service.appendAllocation(request.tenantId, id, input);
    reply.status(201);
    return updated;
  });

  fastify.delete('/applications/:id', async (request, reply) => {
    const { id } = applicationIdParamsSchema.parse(request.params);
    await service.delete(request.tenantId, id);
    reply.status(204);
    return null;
  });
};
