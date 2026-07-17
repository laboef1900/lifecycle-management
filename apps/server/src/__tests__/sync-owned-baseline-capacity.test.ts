import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';

import { makeCluster } from './factories.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

/**
 * Q9a write-time invariant on synced clusters (#196, owner ruling 2026-07-17).
 *
 * A synced cluster's capacity is 100% synced host inventory, so every baseline
 * row must carry baselineCapacity = 0 — otherwise an admin correction reintroduces
 * the double-count (capacity = fleet + fleet ⇒ utilization halved ⇒ hardware never
 * ordered). This constrains ONE field within the sanctioned baseline-correction
 * path: baselineConsumption and baselineDate corrections stay open; a manual
 * cluster is entirely unaffected.
 */
let server: FastifyInstance;

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});

afterAll(async () => {
  await server.close();
});

function errorCode(res: { json: () => unknown }): string {
  return (res.json() as { error: { code: string } }).error.code;
}

describe('baselineCapacity invariant on a synced cluster', () => {
  it('rejects a baseline correction with baselineCapacity != 0 (409 SYNC_OWNED_FIELD)', async () => {
    const cluster = await makeCluster(prisma, { source: 'vsphere' });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: {
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 500, baselineCapacity: 1000 },
        ],
      },
    });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('SYNC_OWNED_FIELD');
  });

  it('allows a baselineConsumption correction when baselineCapacity is 0', async () => {
    const cluster = await makeCluster(prisma, { source: 'vsphere' });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: {
        baselines: [{ metricTypeKey: 'memory_gb', baselineConsumption: 500, baselineCapacity: 0 }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Array<{ baselineConsumption: number }> };
    expect(body.metrics[0]?.baselineConsumption).toBe(500);

    // The correction landed in cluster_baseline_history flipped back to manual.
    const history = await prisma.clusterBaselineHistory.findFirst({
      where: { clusterId: cluster.id },
    });
    expect(history?.source).toBe('manual');
    expect(history?.baselineConsumption.toNumber()).toBe(500);
    expect(history?.baselineCapacity.toNumber()).toBe(0);
  });

  it('allows a baselineDate-only correction on a synced cluster (no baselines)', async () => {
    const cluster = await makeCluster(prisma, { source: 'vsphere' });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-06-01' },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { baselineDate: string }).baselineDate).toBe('2026-06-01');
  });
});

describe('baselineCapacity is unconstrained on a manual cluster', () => {
  it('allows a non-zero baselineCapacity correction (no over-reach)', async () => {
    const cluster = await makeCluster(prisma); // manual by default

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: {
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 500, baselineCapacity: 2000 },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Array<{ baselineCapacity: number }> };
    expect(body.metrics[0]?.baselineCapacity).toBe(2000);
  });
});
