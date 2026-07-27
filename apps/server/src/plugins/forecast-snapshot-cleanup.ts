import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { ForecastSnapshotCleanup } from '../services/forecast-snapshot-cleanup.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Prunes forecast snapshots past each tenant's retention window (#318). Exposed for tests and drain. */
    forecastSnapshotCleanup: ForecastSnapshotCleanup;
  }
}

export interface ForecastSnapshotCleanupPluginOptions {
  /** Mirrors the idempotency-cleanup plugin's own test-environment skip. */
  autostart: boolean;
  /** Tick interval; overridable in tests. */
  tickIntervalMs?: number;
}

const forecastSnapshotCleanupPluginFn: FastifyPluginAsync<
  ForecastSnapshotCleanupPluginOptions
> = async (fastify, opts) => {
  const cleanup = new ForecastSnapshotCleanup(fastify.prisma, {
    info: (details, message) => fastify.log.info(details, message),
    warn: (details, message) => fastify.log.warn(details, message),
  });
  fastify.decorate('forecastSnapshotCleanup', cleanup);

  if (opts.autostart) {
    cleanup.start(opts.tickIntervalMs);
  }

  fastify.addHook('onClose', async () => {
    await cleanup.stop();
  });
};

export const forecastSnapshotCleanupPlugin = fp(forecastSnapshotCleanupPluginFn, {
  name: 'forecast-snapshot-cleanup',
  dependencies: ['prisma'],
});
