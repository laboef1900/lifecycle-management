import { randomBytes } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { prismaPlugin } from '../plugins/prisma.js';
import { vsphereSchedulerPlugin } from '../plugins/vsphere-scheduler.js';
import { buildServer } from '../server.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

/**
 * The plugin that actually starts the scheduler (#191). The activity dispatch and
 * persistence are covered elsewhere; these prove the wiring: it never ticks in test,
 * it does tick when told to, and it drains on shutdown.
 */
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function buildApp(autostart: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin, { prisma });
  await app.register(vsphereSchedulerPlugin, {
    configKey: randomBytes(32),
    autostart,
    // An hour, so the timer is armed but cannot actually fire during the test.
    tickIntervalMs: 60 * 60 * 1000,
  });
  apps.push(app);
  return app;
}

describe('vsphereSchedulerPlugin', () => {
  it('does NOT start the tick when autostart is false', async () => {
    const app = await buildApp(false);
    expect(app.vsphereScheduler.isRunning()).toBe(false);
  });

  it('starts the tick when autostart is true, and stops it on close', async () => {
    const app = await buildApp(true);
    expect(app.vsphereScheduler.isRunning()).toBe(true);

    await app.close();
    apps.length = 0; // already closed
    expect(app.vsphereScheduler.isRunning()).toBe(false);
  });

  it('buildServer never auto-starts the scheduler in the test environment', async () => {
    const server = await buildServer({
      env: makeTestEnv({ CONFIG_ENCRYPTION_KEY: randomBytes(32).toString('base64') }),
      prisma,
    });
    apps.push(server);
    // Mirrors server.ts's NODE_ENV!=='test' skip for rate-limit/under-pressure: a
    // stray background tick would race assertions under isolate:false.
    expect(server.vsphereScheduler.isRunning()).toBe(false);
  });
});
