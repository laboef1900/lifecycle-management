import { categoryCreateInputSchema, categoryIdParamsSchema } from '@lcm/shared';
import type { FastifyPluginAsync } from 'fastify';

import { CategoriesService } from '../services/categories.js';

export const categoriesRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new CategoriesService(fastify.prisma);

  fastify.get('/settings/categories', async (request) => service.list(request.tenantId));

  fastify.post('/settings/categories', async (request, reply) => {
    const input = categoryCreateInputSchema.parse(request.body);
    const created = await service.create(request.tenantId, input.name);
    reply.status(201);
    return created;
  });

  fastify.delete('/settings/categories/:id', async (request, reply) => {
    const { id } = categoryIdParamsSchema.parse(request.params);
    await service.delete(request.tenantId, id);
    reply.status(204);
    return null;
  });
};
