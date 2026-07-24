import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { VsphereClientInventoryCollector } from '../services/vsphere-collector.js';
import { VsphereConnectionsService } from '../services/vsphere-connections.js';
import { VsphereJobRunner } from '../services/vsphere-job-runner.js';
import { VsphereLiveUsageService } from '../services/vsphere-live-usage.js';
import { VsphereScheduler } from '../services/vsphere-scheduler.js';
import { VsphereSnapshotService } from '../services/vsphere-snapshot.js';
import { VsphereSyncService } from '../services/vsphere-sync.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The vCenter poll/sync/snapshot scheduler (#191). Exposed for tests and drain. */
    vsphereScheduler: VsphereScheduler;
  }
}

export interface VsphereSchedulerPluginOptions {
  /**
   * The AES-GCM key for decrypting stored vCenter passwords, derived from
   * CONFIG_ENCRYPTION_KEY in `buildServer`. null when unset — every sync then
   * degrades (the credential cannot be revealed), it does not crash.
   */
  configKey: Buffer | null;
  /**
   * Start the tick? Mirrors `server.ts`'s `NODE_ENV !== 'test'` guard: in test the
   * timer stays off so stray background ticks cannot race assertions across the
   * shared-module run (`isolate: false`). Tests drive `runDueJobs()` directly.
   */
  autostart: boolean;
  /** Tick interval; overridable in tests. Defaults to the scheduler's own 60s. */
  tickIntervalMs?: number;
}

/**
 * Constructs the vСenter scheduler and its job runner, starts the tick outside the
 * test environment, and drains on shutdown (#191, epic #172).
 *
 * @ai-warning This is the ONLY thing that starts the scheduler. Without it,
 * `VsphereScheduler` and all three activity services (built by #178/#179/#187/#188)
 * are dead code — nothing ever polls, syncs, or snapshots.
 */
const vsphereSchedulerPluginFn: FastifyPluginAsync<VsphereSchedulerPluginOptions> = async (
  fastify,
  opts,
) => {
  const collector = new VsphereClientInventoryCollector({
    logger: { warn: (details, message) => fastify.log.warn(details, message) },
  });
  const connections = new VsphereConnectionsService(fastify.prisma, opts.configKey);
  const sync = new VsphereSyncService(fastify.prisma, collector, {
    info: (details, message) => fastify.log.info(details, message),
    warn: (details, message) => fastify.log.warn(details, message),
  });
  const snapshot = new VsphereSnapshotService(fastify.prisma, collector, {
    warn: (details, message) => fastify.log.warn(details, message),
  });
  const liveUsage = new VsphereLiveUsageService(fastify.prisma);

  const runner = new VsphereJobRunner({
    prisma: fastify.prisma,
    connections,
    sync,
    snapshot,
    liveUsage,
    collector,
    // Load-shed the poll under pressure (design §D25). `isUnderPressure` is only
    // decorated when `@fastify/under-pressure` is registered — which `server.ts`
    // skips in test — so the presence guard is required, not belt-and-braces.
    isUnderPressure: () =>
      typeof fastify.isUnderPressure === 'function' ? fastify.isUnderPressure() : false,
  });

  const scheduler = new VsphereScheduler(fastify.prisma, runner);
  fastify.decorate('vsphereScheduler', scheduler);

  if (opts.autostart) {
    scheduler.start(opts.tickIntervalMs);
  }

  // Graceful shutdown: stop the tick, abort in-flight vCenter I/O, drain, release
  // claims — all inside index.ts's 10s close budget (design §D21).
  fastify.addHook('onClose', async () => {
    await scheduler.stop();
  });
};

export const vsphereSchedulerPlugin = fp(vsphereSchedulerPluginFn, {
  name: 'vsphere-scheduler',
  dependencies: ['prisma'],
});
