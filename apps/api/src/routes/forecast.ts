import type { FastifyPluginAsync } from 'fastify';

import { forecastParamsSchema, forecastQuerySchema } from '@lcm/shared';

import { ForecastService } from '../services/forecast-loader.js';

export const forecastRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new ForecastService(fastify.prisma);

  fastify.get('/clusters/:id/forecast', async (request) => {
    const { id } = forecastParamsSchema.parse(request.params);
    const query = forecastQuerySchema.parse(request.query);

    return service.forCluster(request.tenantId, id, query.metric, {
      ...(query.from !== undefined && { fromMonth: query.from }),
      ...(query.to !== undefined && { toMonth: query.to }),
    });
  });
};
