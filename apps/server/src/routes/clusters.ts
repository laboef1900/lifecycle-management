import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';

import {
  clusterCreateInputSchema,
  clusterIdParamsSchema,
  clusterUpdateInputSchema,
  clustersListQuerySchema,
  liveUsageListResponseSchema,
} from '@lcm/shared';

import { ClustersService } from '../services/clusters.js';
import { ForecastService } from '../services/forecast-loader.js';
import { VsphereLiveUsageService } from '../services/vsphere-live-usage.js';

export const clusterRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new ClustersService(fastify.prisma);
  const forecast = new ForecastService(fastify.prisma);
  const liveUsage = new VsphereLiveUsageService(fastify.prisma);

  /**
   * Re-anchor hook (Option A1, snapshot-forward): after a manual baseline
   * capture, persist the current forecast so the empirical uncertainty band can
   * later measure projected-vs-actual. BEST-EFFORT — a snapshot failure MUST NOT
   * fail the baseline write it follows; it only means the band skips this period.
   */
  const accrueSnapshots = async (
    request: { tenantId: string; log: FastifyBaseLogger },
    clusterId: string,
    metricKeys: readonly string[],
  ): Promise<void> => {
    for (const metricKey of new Set(metricKeys)) {
      try {
        await forecast.snapshotForecast(request.tenantId, clusterId, metricKey);
      } catch (err) {
        request.log.warn(
          { err, clusterId, metricKey },
          'forecast snapshot skipped (best-effort, uncertainty band)',
        );
      }
    }
  };

  fastify.get('/clusters', async (request) => {
    const query = clustersListQuerySchema.parse(request.query);
    return service.list(request.tenantId, query);
  });

  // Batch live usage for the fleet console — one entry per SYNCED cluster
  // (#193). Registered before `/clusters/:id` so find-my-way's static-over-
  // parametric precedence is explicit rather than incidental. Serves the
  // Postgres cache only; the discriminated-union payload is validated on the
  // way out so a malformed reading can never reach a renderer.
  fastify.get('/clusters/live-usage', async (request) => {
    const items = await liveUsage.listForTenant(request.tenantId, new Date());
    return liveUsageListResponseSchema.parse({ items });
  });

  fastify.get('/clusters/:id', async (request) => {
    const { id } = clusterIdParamsSchema.parse(request.params);
    return service.getById(request.tenantId, id);
  });

  fastify.post('/clusters', async (request, reply) => {
    const input = clusterCreateInputSchema.parse(request.body);
    const created = await service.create(request.tenantId, input);
    await accrueSnapshots(
      request,
      created.id,
      input.baselines.map((b) => b.metricTypeKey),
    );
    reply.status(201);
    return created;
  });

  fastify.put('/clusters/:id', async (request) => {
    const { id } = clusterIdParamsSchema.parse(request.params);
    const input = clusterUpdateInputSchema.parse(request.body);
    const updated = await service.update(request.tenantId, id, input);
    if (input.baselines !== undefined) {
      await accrueSnapshots(
        request,
        id,
        input.baselines.map((b) => b.metricTypeKey),
      );
    }
    return updated;
  });

  fastify.delete('/clusters/:id', async (request, reply) => {
    const { id } = clusterIdParamsSchema.parse(request.params);
    await service.delete(request.tenantId, id);
    reply.status(204);
    return null;
  });

  fastify.post('/clusters/:id/archive', async (request) => {
    const { id } = clusterIdParamsSchema.parse(request.params);
    return service.archive(request.tenantId, id);
  });

  fastify.post('/clusters/:id/unarchive', async (request) => {
    const { id } = clusterIdParamsSchema.parse(request.params);
    return service.unarchive(request.tenantId, id);
  });
};
