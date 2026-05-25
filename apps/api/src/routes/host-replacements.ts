import type { FastifyPluginAsync } from 'fastify';

import { hostReplacementCreateInputSchema, hostReplacementIdParamsSchema } from '@lcm/shared';

import { HostReplacementsService } from '../services/host-replacements.js';

export const hostReplacementRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new HostReplacementsService(fastify.prisma);

  fastify.post('/host-replacements', async (request, reply) => {
    const input = hostReplacementCreateInputSchema.parse(request.body);
    const created = await service.create(request.tenantId, input);
    reply.status(201);
    return created;
  });

  fastify.delete('/host-replacements/:id', async (request, reply) => {
    const { id } = hostReplacementIdParamsSchema.parse(request.params);
    await service.delete(request.tenantId, id);
    reply.status(204);
    return null;
  });
};
