import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { IdempotencyCleanup } from '../services/idempotency-cleanup.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Purges expired idempotency-key rows (#263). Exposed for tests and drain. */
    idempotencyCleanup: IdempotencyCleanup;
  }
}

export interface IdempotencyCleanupPluginOptions {
  /** Mirrors the vSphere scheduler plugin's own test-environment skip. */
  autostart: boolean;
  /** Tick interval; overridable in tests. */
  tickIntervalMs?: number;
}

const idempotencyCleanupPluginFn: FastifyPluginAsync<IdempotencyCleanupPluginOptions> = async (
  fastify,
  opts,
) => {
  const cleanup = new IdempotencyCleanup(fastify.prisma);
  fastify.decorate('idempotencyCleanup', cleanup);

  if (opts.autostart) {
    cleanup.start(opts.tickIntervalMs);
  }

  fastify.addHook('onClose', async () => {
    await cleanup.stop();
  });
};

export const idempotencyCleanupPlugin = fp(idempotencyCleanupPluginFn, {
  name: 'idempotency-cleanup',
  dependencies: ['prisma'],
});
