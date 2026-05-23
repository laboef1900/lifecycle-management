import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { makeTestEnv } from './test-helpers.js';

const TEST_PREFIX = '__test_cluster_';
const prisma = new PrismaClient();

let server: FastifyInstance;

async function cleanupTestClusters(): Promise<void> {
  await prisma.cluster.deleteMany({
    where: { name: { startsWith: TEST_PREFIX } },
  });
}

beforeAll(async () => {
  await cleanupTestClusters();
  server = await buildServer({ env: makeTestEnv(), prisma });
});

afterEach(cleanupTestClusters);

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

const uniqueName = (suffix: string): string =>
  `${TEST_PREFIX}${suffix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

describe('POST /api/clusters', () => {
  it('creates a cluster with baselines and returns 201', async () => {
    const name = uniqueName('create');
    const response = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name,
        description: 'integration test',
        baselineDate: '2026-05-01',
        baselines: [
          {
            metricTypeKey: 'memory_gb',
            baselineConsumption: 100,
            baselineCapacity: 1000,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      id: string;
      name: string;
      baselineDate: string;
      metrics: Array<{
        metricTypeKey: string;
        baselineConsumption: number;
        baselineCapacity: number;
        currentConsumption: number;
        currentCapacity: number;
        utilization: number;
      }>;
    };
    expect(body.name).toBe(name);
    expect(body.baselineDate).toBe('2026-05-01');
    expect(body.metrics).toHaveLength(1);
    expect(body.metrics[0]).toMatchObject({
      metricTypeKey: 'memory_gb',
      baselineConsumption: 100,
      baselineCapacity: 1000,
      currentConsumption: 100,
      currentCapacity: 1000,
      utilization: 0.1,
    });
  });

  it('returns 400 on missing required fields', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: { name: '' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 when referencing an unknown metric key', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name: uniqueName('bad_metric'),
        baselineDate: '2026-05-01',
        baselines: [{ metricTypeKey: 'plutonium_kg', baselineConsumption: 1, baselineCapacity: 2 }],
      },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('UNKNOWN_METRIC');
  });

  it('returns 409 when name already exists for the tenant', async () => {
    const name = uniqueName('dup');
    const payload = {
      name,
      baselineDate: '2026-05-01',
      baselines: [{ metricTypeKey: 'memory_gb', baselineConsumption: 1, baselineCapacity: 2 }],
    };
    const first = await server.inject({ method: 'POST', url: '/api/clusters', payload });
    expect(first.statusCode).toBe(201);
    const second = await server.inject({ method: 'POST', url: '/api/clusters', payload });
    expect(second.statusCode).toBe(409);
    const body = second.json() as { error: { code: string } };
    expect(body.error.code).toBe('CLUSTER_NAME_TAKEN');
  });
});

describe('GET /api/clusters', () => {
  it('returns the list of clusters with current state', async () => {
    const name = uniqueName('list');
    await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name,
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 2000, baselineCapacity: 4000 },
        ],
      },
    });

    const response = await server.inject({ method: 'GET', url: '/api/clusters' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{
      name: string;
      metrics: Array<{ utilization: number }>;
    }>;
    const ours = body.find((c) => c.name === name);
    expect(ours).toBeDefined();
    expect(ours?.metrics[0]?.utilization).toBe(0.5);
  });
});

describe('GET /api/clusters/:id', () => {
  it('returns 200 and the cluster detail', async () => {
    const name = uniqueName('get');
    const created = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name,
        baselineDate: '2026-05-01',
        baselines: [{ metricTypeKey: 'memory_gb', baselineConsumption: 1, baselineCapacity: 2 }],
      },
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({ method: 'GET', url: `/api/clusters/${id}` });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { name: string }).name).toBe(name);
  });

  it('returns 404 for an unknown id', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/clusters/does-not-exist' });
    expect(response.statusCode).toBe(404);
    const body = response.json() as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('PUT /api/clusters/:id', () => {
  it('updates the cluster fields', async () => {
    const name = uniqueName('put');
    const created = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name,
        baselineDate: '2026-05-01',
        baselines: [{ metricTypeKey: 'memory_gb', baselineConsumption: 1, baselineCapacity: 2 }],
      },
    });
    const { id } = created.json() as { id: string };

    const renamed = `${name}_renamed`;
    const response = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${id}`,
      payload: { name: renamed, description: 'updated' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { name: string; description: string };
    expect(body.name).toBe(renamed);
    expect(body.description).toBe('updated');
  });

  it('returns 404 for unknown id', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: '/api/clusters/missing',
      payload: { name: 'whatever' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 409 on rename conflict', async () => {
    const baseName = uniqueName('conflict');
    const otherName = uniqueName('conflict_other');
    const baselinePayload = {
      baselineDate: '2026-05-01',
      baselines: [{ metricTypeKey: 'memory_gb', baselineConsumption: 1, baselineCapacity: 2 }],
    };
    await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: { name: baseName, ...baselinePayload },
    });
    const other = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: { name: otherName, ...baselinePayload },
    });
    const { id: otherId } = other.json() as { id: string };

    const conflict = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${otherId}`,
      payload: { name: baseName },
    });
    expect(conflict.statusCode).toBe(409);
  });
});

describe('DELETE /api/clusters/:id', () => {
  it('removes the cluster and cascades baselines', async () => {
    const name = uniqueName('delete');
    const created = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name,
        baselineDate: '2026-05-01',
        baselines: [{ metricTypeKey: 'memory_gb', baselineConsumption: 1, baselineCapacity: 2 }],
      },
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({ method: 'DELETE', url: `/api/clusters/${id}` });
    expect(response.statusCode).toBe(204);

    const followup = await server.inject({ method: 'GET', url: `/api/clusters/${id}` });
    expect(followup.statusCode).toBe(404);

    const remainingBaselines = await prisma.clusterMetricBaseline.count({
      where: { clusterId: id },
    });
    expect(remainingBaselines).toBe(0);
  });

  it('returns 404 for unknown id', async () => {
    const response = await server.inject({ method: 'DELETE', url: '/api/clusters/missing' });
    expect(response.statusCode).toBe(404);
  });
});
