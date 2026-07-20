import {
  clusterIdItemsParamsSchema,
  itemAllocationRowInputSchema,
  itemBulkShiftDatesInputSchema,
  itemCreateInputSchema,
  itemIdParamsSchema,
  itemUpdateInputSchema,
  paginationQuerySchema,
} from '@lcm/shared';
import type { FastifyPluginAsync } from 'fastify';

import { ItemsService } from '../services/items.js';

export const itemsRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new ItemsService(fastify.prisma);

  fastify.get('/clusters/:clusterId/items', async (request) => {
    const { clusterId } = clusterIdItemsParamsSchema.parse(request.params);
    const { limit, offset } = paginationQuerySchema.parse(request.query);
    return service.listByCluster(request.tenantId, clusterId, { limit, offset });
  });

  fastify.post('/clusters/:clusterId/items', async (request, reply) => {
    const { clusterId } = clusterIdItemsParamsSchema.parse(request.params);
    const input = itemCreateInputSchema.parse(request.body);
    const created = await service.create(request.tenantId, clusterId, input);
    reply.status(201);
    return created;
  });

  fastify.patch('/items/:id', async (request) => {
    const { id } = itemIdParamsSchema.parse(request.params);
    const input = itemUpdateInputSchema.parse(request.body);
    return service.update(request.tenantId, id, input);
  });

  // Static segment, so it never shadows (or is shadowed by) `/items/:id/...`.
  // Admin-gated automatically: a mutating /api route outside the read-only
  // exemption list (see `requiresAdmin` in plugins/auth.ts).
  fastify.post('/items/bulk-shift-dates', async (request) => {
    const input = itemBulkShiftDatesInputSchema.parse(request.body);
    return service.bulkShiftDates(request.tenantId, input);
  });

  fastify.post('/items/:id/allocations', async (request, reply) => {
    const { id } = itemIdParamsSchema.parse(request.params);
    const input = itemAllocationRowInputSchema.parse(request.body);
    const updated = await service.appendAllocation(request.tenantId, id, input);
    reply.status(201);
    return updated;
  });

  fastify.delete('/items/:id', async (request, reply) => {
    const { id } = itemIdParamsSchema.parse(request.params);
    await service.delete(request.tenantId, id);
    reply.status(204);
    return null;
  });
};
