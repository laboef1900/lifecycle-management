import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { makeTestEnv } from './test-helpers.js';

const CLUSTER_PREFIX = '__test_hosts_cluster_';
const prisma = new PrismaClient();

let server: FastifyInstance;
let clusterId: string;

async function cleanupTestClusters(): Promise<void> {
  await prisma.cluster.deleteMany({
    where: { name: { startsWith: CLUSTER_PREFIX } },
  });
}

async function createCluster(): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/clusters',
    payload: {
      name: `${CLUSTER_PREFIX}${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      baselineDate: '2026-05-01',
      baselines: [{ metricTypeKey: 'memory_gb', baselineConsumption: 0, baselineCapacity: 0 }],
    },
  });
  return (response.json() as { id: string }).id;
}

beforeAll(async () => {
  await cleanupTestClusters();
  server = await buildServer({ env: makeTestEnv(), prisma });
});

beforeEach(async () => {
  await cleanupTestClusters();
  clusterId = await createCluster();
});

afterAll(async () => {
  await cleanupTestClusters();
  await server.close();
  await prisma.$disconnect();
});

const hostPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: `host-${Math.floor(Math.random() * 1e6)}`,
  commissionedAt: '2026-05-01',
  capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 512 }],
  ...overrides,
});

describe('POST /api/clusters/:clusterId/hosts', () => {
  it('creates a host with an initial capacity row and returns 201', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      id: string;
      clusterId: string;
      capacities: Array<{ effectiveFrom: string; amount: number; metricTypeKey: string }>;
    };
    expect(body.clusterId).toBe(clusterId);
    expect(body.capacities).toHaveLength(1);
    expect(body.capacities[0]).toMatchObject({
      effectiveFrom: '2026-05-01',
      amount: 512,
      metricTypeKey: 'memory_gb',
    });
  });

  it('returns 404 when the cluster does not exist', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/clusters/missing/hosts',
      payload: hostPayload(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 422 when capacity effectiveFrom is before commissionedAt', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        commissionedAt: '2026-06-01',
        capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 }],
      }),
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EFFECTIVE_BEFORE_COMMISSION',
    );
  });

  it('returns 422 on duplicate effectiveFrom for the same metric', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        capacities: [
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 },
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 512 },
        ],
      }),
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EFFECTIVE_NOT_MONOTONIC',
    );
  });

  it('accepts multiple capacities for the same metric in strictly increasing order', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        capacities: [
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 },
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-08-01', amount: 512 },
        ],
      }),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { capacities: Array<{ effectiveFrom: string }> };
    expect(body.capacities).toHaveLength(2);
  });
});

describe('GET /api/clusters/:clusterId/hosts', () => {
  it('returns hosts attached to the cluster', async () => {
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({ name: 'host-a' }),
    });
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({ name: 'host-b' }),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/hosts`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ name: string }>;
    expect(body.map((h) => h.name).sort()).toEqual(['host-a', 'host-b']);
  });

  it('returns 404 when the cluster does not exist', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/clusters/missing/hosts',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET / PUT / DELETE /api/hosts/:id', () => {
  it('GET returns the host', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({ name: 'detail-host' }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({ method: 'GET', url: `/api/hosts/${id}` });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { name: string }).name).toBe('detail-host');
  });

  it('GET returns 404 for unknown id', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/hosts/missing' });
    expect(response.statusCode).toBe(404);
  });

  it('PUT updates name and decommissionedAt without dropping capacity history', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        name: 'old-name',
        capacities: [
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 },
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-09-01', amount: 512 },
        ],
      }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'PUT',
      url: `/api/hosts/${id}`,
      payload: { name: 'new-name', decommissionedAt: '2027-01-01' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      name: string;
      decommissionedAt: string;
      capacities: unknown[];
    };
    expect(body.name).toBe('new-name');
    expect(body.decommissionedAt).toBe('2027-01-01');
    expect(body.capacities).toHaveLength(2);
  });

  it('PUT rejects commissionedAt after earliest capacity', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 }],
      }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'PUT',
      url: `/api/hosts/${id}`,
      payload: { commissionedAt: '2026-06-01' },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'INVALID_COMMISSIONED_AT',
    );
  });

  it('DELETE removes the host and cascades capacities', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload(),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({ method: 'DELETE', url: `/api/hosts/${id}` });
    expect(response.statusCode).toBe(204);

    const followup = await server.inject({ method: 'GET', url: `/api/hosts/${id}` });
    expect(followup.statusCode).toBe(404);
    const remaining = await prisma.hostMetricCapacity.count({ where: { hostId: id } });
    expect(remaining).toBe(0);
  });
});

describe('POST /api/hosts/:id/capacity', () => {
  it('appends a new capacity row and never updates the previous one', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 }],
      }),
    });
    const { id, capacities } = created.json() as {
      id: string;
      capacities: Array<{ id: string; amount: number; effectiveFrom: string }>;
    };
    const originalRowId = capacities[0]?.id;
    expect(originalRowId).toBeDefined();

    const append = await server.inject({
      method: 'POST',
      url: `/api/hosts/${id}/capacity`,
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-08-01', amount: 512 },
    });
    expect(append.statusCode).toBe(201);
    const body = append.json() as {
      capacities: Array<{ id: string; effectiveFrom: string; amount: number }>;
    };
    expect(body.capacities).toHaveLength(2);
    const original = body.capacities.find((c) => c.id === originalRowId);
    expect(original).toMatchObject({ effectiveFrom: '2026-05-01', amount: 256 });
  });

  it('returns 422 when effectiveFrom is not strictly after the latest row', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        capacities: [
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 },
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-08-01', amount: 512 },
        ],
      }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'POST',
      url: `/api/hosts/${id}/capacity`,
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-08-01', amount: 768 },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EFFECTIVE_NOT_MONOTONIC',
    );
  });

  it('returns 422 when effectiveFrom is before commissionedAt', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        commissionedAt: '2026-06-01',
        capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 256 }],
      }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'POST',
      url: `/api/hosts/${id}/capacity`,
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EFFECTIVE_BEFORE_COMMISSION',
    );
  });

  it('returns 404 when the host does not exist', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/hosts/missing/capacity',
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 },
    });
    expect(response.statusCode).toBe(404);
  });
});
