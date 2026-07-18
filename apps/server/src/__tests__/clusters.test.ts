import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});

afterAll(async () => {
  await server.close();
});

let sequence = 0;
const uniqueName = (suffix: string): string => {
  sequence += 1;
  return `cluster-${suffix}-${sequence}`;
};

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

  it('reports utilization null (never 0) for a zero-capacity cluster', async () => {
    // A cluster with capacity 0 — a synced cluster before its hosts carry capacity,
    // or any zero-capacity month. Rendering "0% used" here reads as "healthy, plenty
    // of headroom", the exact lie Q9d exists to prevent on purchasing surfaces.
    const name = uniqueName('zero-capacity');
    const response = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name,
        baselineDate: '2026-05-01',
        baselines: [{ metricTypeKey: 'memory_gb', baselineConsumption: 50, baselineCapacity: 0 }],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      metrics: Array<{ currentCapacity: number; utilization: number | null }>;
    };
    expect(body.metrics[0]!.currentCapacity).toBe(0);
    expect(body.metrics[0]!.utilization).toBeNull();
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
    const body = response.json() as {
      items: Array<{ name: string; metrics: Array<{ utilization: number }> }>;
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
    const ours = body.items.find((c) => c.name === name);
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

  /**
   * Regression for #181. `update` replaced baselines with deleteMany + createMany
   * scoped to `clusterId` only, so a partial `baselines` array silently destroyed
   * the omitted metrics' baselines. The update schema permits a partial array
   * (`.min(1)` — "at least one", not "all of them"), and baselines drive hardware
   * purchasing, so the loss has to be impossible rather than merely unlikely.
   */
  it('leaves omitted metrics untouched when baselines is partial', async () => {
    await prisma.metricType.upsert({
      where: { key: 'cpu_cores_181' },
      update: {},
      create: { key: 'cpu_cores_181', displayName: 'CPU (test)', unit: 'cores' },
    });

    const name = uniqueName('partial-baselines');
    const created = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name,
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
          { metricTypeKey: 'cpu_cores_181', baselineConsumption: 8, baselineCapacity: 64 },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };

    // Update ONLY memory — cpu_cores_181 is absent from the payload.
    const response = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${id}`,
      payload: {
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 150, baselineCapacity: 1000 },
        ],
      },
    });
    expect(response.statusCode).toBe(200);

    const rows = await prisma.clusterMetricBaseline.findMany({
      where: { clusterId: id },
      include: { metricType: { select: { key: true } } },
    });
    const byKey = new Map(rows.map((r) => [r.metricType.key, r]));

    // The omitted metric survives, unchanged.
    expect(byKey.get('cpu_cores_181')).toBeDefined();
    expect(byKey.get('cpu_cores_181')?.baselineConsumption.toNumber()).toBe(8);
    expect(byKey.get('cpu_cores_181')?.baselineCapacity.toNumber()).toBe(64);

    // The supplied metric is updated.
    expect(byKey.get('memory_gb')?.baselineConsumption.toNumber()).toBe(150);
  });

  it('updates every supplied metric when baselines covers them all', async () => {
    await prisma.metricType.upsert({
      where: { key: 'cpu_cores_181' },
      update: {},
      create: { key: 'cpu_cores_181', displayName: 'CPU (test)', unit: 'cores' },
    });

    const name = uniqueName('full-baselines');
    const created = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name,
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
          { metricTypeKey: 'cpu_cores_181', baselineConsumption: 8, baselineCapacity: 64 },
        ],
      },
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${id}`,
      payload: {
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 150, baselineCapacity: 1200 },
          { metricTypeKey: 'cpu_cores_181', baselineConsumption: 16, baselineCapacity: 96 },
        ],
      },
    });
    expect(response.statusCode).toBe(200);

    const rows = await prisma.clusterMetricBaseline.findMany({
      where: { clusterId: id },
      include: { metricType: { select: { key: true } } },
    });
    expect(rows).toHaveLength(2);
    const byKey = new Map(rows.map((r) => [r.metricType.key, r]));
    expect(byKey.get('memory_gb')?.baselineConsumption.toNumber()).toBe(150);
    expect(byKey.get('memory_gb')?.baselineCapacity.toNumber()).toBe(1200);
    expect(byKey.get('cpu_cores_181')?.baselineConsumption.toNumber()).toBe(16);
    expect(byKey.get('cpu_cores_181')?.baselineCapacity.toNumber()).toBe(96);
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

describe('POST /api/clusters/:id/archive', () => {
  it('sets archivedAt and returns the cluster', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name: uniqueName('archive'),
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = createRes.json() as { id: string };

    const archiveRes = await server.inject({
      method: 'POST',
      url: `/api/clusters/${id}/archive`,
    });
    expect(archiveRes.statusCode).toBe(200);
    const body = archiveRes.json() as { archivedAt: string | null };
    expect(body.archivedAt).not.toBeNull();
    expect(new Date(body.archivedAt!).getTime()).toBeGreaterThan(0);
  });

  it('is idempotent — re-archiving keeps the original timestamp', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name: uniqueName('archive-idem'),
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = createRes.json() as { id: string };

    const first = await server.inject({ method: 'POST', url: `/api/clusters/${id}/archive` });
    const firstBody = first.json() as { archivedAt: string };
    const second = await server.inject({ method: 'POST', url: `/api/clusters/${id}/archive` });
    const secondBody = second.json() as { archivedAt: string };
    expect(secondBody.archivedAt).toBe(firstBody.archivedAt);
  });

  it('returns 404 for unknown cluster', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/clusters/clbogusclubogusclubogus0/archive',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/clusters/:id/unarchive', () => {
  it('clears archivedAt', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name: uniqueName('unarchive'),
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = createRes.json() as { id: string };

    await server.inject({ method: 'POST', url: `/api/clusters/${id}/archive` });
    const res = await server.inject({ method: 'POST', url: `/api/clusters/${id}/unarchive` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { archivedAt: string | null };
    expect(body.archivedAt).toBeNull();
  });
});

describe('GET /api/clusters (archived filter)', () => {
  it('hides archived clusters by default', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name: uniqueName('hidden-by-default'),
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = createRes.json() as { id: string };
    await server.inject({ method: 'POST', url: `/api/clusters/${id}/archive` });

    const listRes = await server.inject({ method: 'GET', url: '/api/clusters' });
    const body = listRes.json() as { items: Array<{ id: string }> };
    expect(body.items.some((c) => c.id === id)).toBe(false);
  });

  it('returns archived clusters when includeArchived=true', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name: uniqueName('shown-with-flag'),
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = createRes.json() as { id: string };
    await server.inject({ method: 'POST', url: `/api/clusters/${id}/archive` });

    const listRes = await server.inject({
      method: 'GET',
      url: '/api/clusters?includeArchived=true',
    });
    const body = listRes.json() as { items: Array<{ id: string; archivedAt: string | null }> };
    const found = body.items.find((c) => c.id === id);
    expect(found).toBeDefined();
    expect(found!.archivedAt).not.toBeNull();
  });
});

describe('GET /api/clusters/:id (archived)', () => {
  it('returns archived clusters from the detail endpoint', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name: uniqueName('detail-archived'),
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = createRes.json() as { id: string };
    await server.inject({ method: 'POST', url: `/api/clusters/${id}/archive` });

    const detailRes = await server.inject({ method: 'GET', url: `/api/clusters/${id}` });
    expect(detailRes.statusCode).toBe(200);
    const body = detailRes.json() as { id: string; archivedAt: string | null };
    expect(body.id).toBe(id);
    expect(body.archivedAt).not.toBeNull();
  });
});

describe('GET /api/clusters pagination', () => {
  it('paginates results via limit/offset', async () => {
    for (let i = 0; i < 3; i += 1) {
      await server.inject({
        method: 'POST',
        url: '/api/clusters',
        payload: {
          name: uniqueName(`page-${i}`),
          baselineDate: '2026-05-01',
          baselines: [
            { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
          ],
        },
      });
    }

    const firstPage = await server.inject({ method: 'GET', url: '/api/clusters?limit=2' });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json() as {
      items: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.total).toBe(3);
    expect(firstBody.limit).toBe(2);
    expect(firstBody.offset).toBe(0);

    const secondPage = await server.inject({
      method: 'GET',
      url: '/api/clusters?limit=2&offset=2',
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json() as { items: unknown[]; total: number };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.total).toBe(3);
  });
});
