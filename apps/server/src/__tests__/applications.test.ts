import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { makeCluster } from './factories.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

let server: FastifyInstance;
let clusterId: string;

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});

beforeEach(async () => {
  const cluster = await makeCluster(prisma);
  clusterId = cluster.id;
});

afterAll(async () => {
  await server.close();
});

const appPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: `app-${Math.floor(Math.random() * 1e6)}`,
  category: 'openshift',
  startedAt: '2026-06-01',
  allocations: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 144 }],
  ...overrides,
});

describe('POST /api/clusters/:clusterId/applications', () => {
  it('creates an application with an initial allocation and returns 201', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: appPayload(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      clusterId: string;
      category: string;
      allocations: Array<{ effectiveFrom: string; amount: number }>;
    };
    expect(body.clusterId).toBe(clusterId);
    expect(body.category).toBe('openshift');
    expect(body.allocations).toHaveLength(1);
    expect(body.allocations[0]).toMatchObject({ effectiveFrom: '2026-06-01', amount: 144 });
  });

  it('accepts an arbitrary free-form category (no enum constraint)', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: appPayload({ category: 'kafka-cluster' }),
    });
    expect(response.statusCode).toBe(201);
    expect((response.json() as { category: string }).category).toBe('kafka-cluster');
  });

  it('returns 404 when the cluster does not exist', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/clusters/missing/applications',
      payload: appPayload(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 422 when allocation effectiveFrom is before startedAt', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: appPayload({
        startedAt: '2026-07-01',
        allocations: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 100 }],
      }),
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EFFECTIVE_BEFORE_START',
    );
  });

  it('returns 422 when allocation rows for the same metric are not monotonic', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: appPayload({
        allocations: [
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 100 },
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 200 },
        ],
      }),
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EFFECTIVE_NOT_MONOTONIC',
    );
  });

  it('accepts multiple allocations in strictly increasing order', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: appPayload({
        allocations: [
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 144 },
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-10-01', amount: 288 },
        ],
      }),
    });
    expect(response.statusCode).toBe(201);
    expect((response.json() as { allocations: unknown[] }).allocations).toHaveLength(2);
  });
});

describe('GET /api/clusters/:clusterId/applications', () => {
  it('returns applications attached to the cluster', async () => {
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: appPayload({ name: 'app-a' }),
    });
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: appPayload({ name: 'app-b' }),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/applications`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ name: string }>;
    expect(body.map((a) => a.name).sort()).toEqual(['app-a', 'app-b']);
  });

  it('returns 404 when the cluster does not exist', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/clusters/missing/applications',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET / PUT / DELETE /api/applications/:id', () => {
  it('GET returns the application', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: appPayload({ name: 'detail-app' }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({ method: 'GET', url: `/api/applications/${id}` });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { name: string }).name).toBe('detail-app');
  });

  it('GET returns 404 for unknown id', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/applications/missing' });
    expect(response.statusCode).toBe(404);
  });

  it('PUT updates fields and preserves allocation history when ending', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: appPayload({
        name: 'old-app',
        category: 'openshift',
        allocations: [
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 144 },
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-10-01', amount: 288 },
        ],
      }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'PUT',
      url: `/api/applications/${id}`,
      payload: { name: 'new-app', category: 'k8s', endedAt: '2027-12-31' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      name: string;
      category: string;
      endedAt: string;
      allocations: unknown[];
    };
    expect(body.name).toBe('new-app');
    expect(body.category).toBe('k8s');
    expect(body.endedAt).toBe('2027-12-31');
    expect(body.allocations).toHaveLength(2);
  });

  it('PUT rejects startedAt after earliest allocation', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: appPayload({
        allocations: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 144 }],
      }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'PUT',
      url: `/api/applications/${id}`,
      payload: { startedAt: '2026-07-01' },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe('INVALID_STARTED_AT');
  });

  it('DELETE removes the application and cascades allocations', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: appPayload(),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({ method: 'DELETE', url: `/api/applications/${id}` });
    expect(response.statusCode).toBe(204);

    const followup = await server.inject({ method: 'GET', url: `/api/applications/${id}` });
    expect(followup.statusCode).toBe(404);
    const remaining = await prisma.applicationMetricAllocation.count({
      where: { applicationId: id },
    });
    expect(remaining).toBe(0);
  });
});

describe('POST /api/applications/:id/allocation', () => {
  it('appends a new allocation row and never updates the previous one', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: appPayload({
        allocations: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 144 }],
      }),
    });
    const { id, allocations } = created.json() as {
      id: string;
      allocations: Array<{ id: string; amount: number; effectiveFrom: string }>;
    };
    const originalRowId = allocations[0]?.id;
    expect(originalRowId).toBeDefined();

    const append = await server.inject({
      method: 'POST',
      url: `/api/applications/${id}/allocation`,
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-12-01', amount: 432 },
    });
    expect(append.statusCode).toBe(201);
    const body = append.json() as {
      allocations: Array<{ id: string; effectiveFrom: string; amount: number }>;
    };
    expect(body.allocations).toHaveLength(2);
    const original = body.allocations.find((a) => a.id === originalRowId);
    expect(original).toMatchObject({ effectiveFrom: '2026-06-01', amount: 144 });
  });

  it('returns 422 when effectiveFrom is not strictly after the latest row', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: appPayload({
        allocations: [
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 144 },
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-10-01', amount: 288 },
        ],
      }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'POST',
      url: `/api/applications/${id}/allocation`,
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-10-01', amount: 400 },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EFFECTIVE_NOT_MONOTONIC',
    );
  });

  it('returns 422 when effectiveFrom is before startedAt', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: appPayload({
        startedAt: '2026-06-01',
        allocations: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 144 }],
      }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'POST',
      url: `/api/applications/${id}/allocation`,
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 200 },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EFFECTIVE_BEFORE_START',
    );
  });

  it('returns 404 when the application does not exist', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/applications/missing/allocation',
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 144 },
    });
    expect(response.statusCode).toBe(404);
  });
});
