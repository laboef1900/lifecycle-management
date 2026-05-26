import type { FastifyPluginAsync } from 'fastify';

import { forecastParamsSchema, forecastQuerySchema, scenarioSchema } from '@lcm/shared';

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

  fastify.post('/clusters/:id/forecast/scenario', async (request) => {
    const { id } = forecastParamsSchema.parse(request.params);
    const query = forecastQuerySchema.parse(request.query);
    const scenario = scenarioSchema.parse(request.body);

    return service.forClusterWithScenario(request.tenantId, id, query.metric, scenario, {
      ...(query.from !== undefined && { fromMonth: query.from }),
      ...(query.to !== undefined && { toMonth: query.to }),
    });
  });
};
