import type { FastifyPluginAsync } from 'fastify';

import { forecastParamsSchema, forecastQuerySchema, scenarioRequestSchema } from '@lcm/shared';

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

  // @ai-warning Keep this exact path. It is the sole entry in
  // `plugins/auth.ts`'s READ_ONLY_MUTATION_ROUTES, the allowlist that exempts
  // this one mutating route from the admin gate so VIEWERs can run previews. A
  // renamed or added path 403s every VIEWER, and the failure looks like an
  // unrelated permissions bug.
  fastify.post('/clusters/:id/forecast/scenario', async (request) => {
    const { id } = forecastParamsSchema.parse(request.params);
    const query = forecastQuerySchema.parse(request.query);
    // Accepts a bare single scenario or a `{ steps: [...] }` stack, normalised to
    // the latter — additive so an older SPA keeps working (#323).
    const { steps } = scenarioRequestSchema.parse(request.body);

    return service.forClusterWithScenario(request.tenantId, id, query.metric, steps, {
      ...(query.from !== undefined && { fromMonth: query.from }),
      ...(query.to !== undefined && { toMonth: query.to }),
    });
  });
};
