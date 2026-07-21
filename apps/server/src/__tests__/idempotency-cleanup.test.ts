import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { idempotencyCleanupPlugin } from '../plugins/idempotency-cleanup.js';
import { prismaPlugin } from '../plugins/prisma.js';
import { IdempotencyCleanup } from '../services/idempotency-cleanup.js';
import { buildServer } from '../server.js';

import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

describe('IdempotencyCleanup', () => {
  it('sweep deletes only expired rows', async () => {
    const cleanup = new IdempotencyCleanup(prisma);
    const now = Date.now();
    await prisma.idempotencyKey.createMany({
      data: [
        {
          key: 'expired-1',
          route: 'r',
          requestHash: 'h',
          responseStatus: 200,
          responseBody: {},
          expiresAt: new Date(now - 1000),
        },
        {
          key: 'still-valid-1',
          route: 'r',
          requestHash: 'h',
          responseStatus: 200,
          responseBody: {},
          expiresAt: new Date(now + 60 * 60 * 1000),
        },
      ],
    });

    const deleted = await cleanup.sweep();
    expect(deleted).toBe(1);

    const remaining = await prisma.idempotencyKey.findMany({ select: { key: true } });
    expect(remaining.map((r) => r.key)).toEqual(['still-valid-1']);
  });

  it('sweep logs a warning and resolves to 0 instead of throwing when the delete fails', async () => {
    const warn = vi.fn();
    const cleanup = new IdempotencyCleanup(prisma, { warn });
    const deleteManySpy = vi
      .spyOn(prisma.idempotencyKey, 'deleteMany')
      .mockRejectedValueOnce(new Error('connection lost'));

    const deleted = await cleanup.sweep();

    expect(deleted).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'idempotency-key cleanup sweep failed',
    );

    deleteManySpy.mockRestore();
  });
});

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function buildApp(autostart: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin, { prisma });
  await app.register(idempotencyCleanupPlugin, {
    autostart,
    tickIntervalMs: 60 * 60 * 1000,
  });
  apps.push(app);
  return app;
}

describe('idempotencyCleanupPlugin', () => {
  it('does NOT start the tick when autostart is false', async () => {
    const app = await buildApp(false);
    expect(app.idempotencyCleanup.isRunning()).toBe(false);
  });

  it('starts the tick when autostart is true, and stops it on close', async () => {
    const app = await buildApp(true);
    expect(app.idempotencyCleanup.isRunning()).toBe(true);

    await app.close();
    apps.length = 0;
    expect(app.idempotencyCleanup.isRunning()).toBe(false);
  });

  it('buildServer never auto-starts the cleanup tick in the test environment', async () => {
    const server = await buildServer({ env: makeTestEnv(), prisma });
    apps.push(server);
    expect(server.idempotencyCleanup.isRunning()).toBe(false);
  });
});
