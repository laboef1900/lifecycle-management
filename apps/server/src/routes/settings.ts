import type { FastifyPluginAsync } from 'fastify';

import {
  clusterIdParamsSchema,
  clusterSettingsInputSchema,
  tenantSettingsSchema,
} from '@lcm/shared';

import { SettingsService } from '../services/settings.js';

export const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new SettingsService(fastify.prisma);

  fastify.get('/settings/tenant', async (request) => {
    return service.getTenant(request.tenantId);
  });

  fastify.put('/settings/tenant', async (request) => {
    const input = tenantSettingsSchema.parse(request.body);
    return service.updateTenant(request.tenantId, input);
  });

  fastify.get('/clusters/:id/settings', async (request) => {
    const { id } = clusterIdParamsSchema.parse(request.params);
    return service.getCluster(request.tenantId, id);
  });

  fastify.put('/clusters/:id/settings', async (request) => {
    const { id } = clusterIdParamsSchema.parse(request.params);
    const input = clusterSettingsInputSchema.parse(request.body);
    return service.updateCluster(request.tenantId, id, input);
  });

  fastify.delete('/clusters/:id/settings', async (request) => {
    const { id } = clusterIdParamsSchema.parse(request.params);
    return service.resetCluster(request.tenantId, id);
  });
};
