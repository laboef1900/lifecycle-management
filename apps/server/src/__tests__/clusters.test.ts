import { clusterResponseSchema } from '@lcm/shared';
import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { makeCluster, makeEvent } from './factories.js';
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

/**
 * The newest baseline-history row per metric — the same reduction the API
 * performs, re-derived here rather than assumed.
 *
 * Asserting on a raw row count instead would be unsound against this table: its
 * unique key includes `capturedAt`, so the count is metrics x periods, and an
 * appended period reads exactly like an updated one. (The legacy table these
 * assertions used to target was keyed on (cluster, metric) alone, which is what
 * made a bare count meaningful there and meaningless here.)
 */
async function newestBaselinesByMetric(
  clusterId: string,
): Promise<Map<string, { baselineConsumption: number; baselineCapacity: number }>> {
  const rows = await prisma.clusterBaselineHistory.findMany({
    where: { clusterId },
    include: { metricType: { select: { key: true } } },
    orderBy: { capturedAt: 'asc' },
  });
  const newest = new Map<string, { baselineConsumption: number; baselineCapacity: number }>();
  for (const row of rows) {
    // Ascending, so the last write per metric is that metric's newest.
    newest.set(row.metricType.key, {
      baselineConsumption: row.baselineConsumption.toNumber(),
      baselineCapacity: row.baselineCapacity.toNumber(),
    });
  }
  return newest;
}

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

    const byKey = await newestBaselinesByMetric(id);

    // The omitted metric survives, unchanged.
    expect(byKey.get('cpu_cores_181')).toBeDefined();
    expect(byKey.get('cpu_cores_181')?.baselineConsumption).toBe(8);
    expect(byKey.get('cpu_cores_181')?.baselineCapacity).toBe(64);

    // The supplied metric is updated.
    expect(byKey.get('memory_gb')?.baselineConsumption).toBe(150);
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

    const byKey = await newestBaselinesByMetric(id);
    expect([...byKey.keys()].sort()).toEqual(['cpu_cores_181', 'memory_gb']);
    expect(byKey.get('memory_gb')?.baselineConsumption).toBe(150);
    expect(byKey.get('memory_gb')?.baselineCapacity).toBe(1200);
    expect(byKey.get('cpu_cores_181')?.baselineConsumption).toBe(16);
    expect(byKey.get('cpu_cores_181')?.baselineCapacity).toBe(96);

    // A payload naming no date corrects the period it is correcting: both rows
    // were updated in place, so no second period was appended.
    expect(await prisma.clusterBaselineHistory.count({ where: { clusterId: id } })).toBe(2);
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

    const remainingBaselines = await prisma.clusterBaselineHistory.count({
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

describe('ClusterResponse.metrics is derived from baseline history', () => {
  it('serves metrics for a synced cluster that has history rows and nothing else', async () => {
    // THE LIVE BUG #195 FIXES. VsphereSyncService creates a cluster with no
    // baseline row at all, and VsphereSnapshotService writes ONLY
    // cluster_baseline_history — so while `metrics` was built from the legacy
    // cluster_metric_baselines table, every vSphere-synced cluster served
    // `metrics: []` on list and detail (rendered as "No metric configured" on the
    // fleet console) while its /forecast endpoint worked fine. Nothing caught it
    // because the makeCluster factory wrote both tables.
    const metric = await prisma.metricType.findUniqueOrThrow({ where: { key: 'memory_gb' } });
    const cluster = await prisma.cluster.create({
      data: {
        tenantId: 'default',
        name: uniqueName('synced-history-only'),
        source: 'vsphere',
        lastSyncedAt: new Date(),
        baselineHistory: {
          create: {
            tenantId: 'default',
            metricTypeId: metric.id,
            capturedAt: new Date(Date.UTC(2026, 4, 1)),
            source: 'vsphere',
            baselineConsumption: 4000,
            // VsphereSnapshotService writes 0 deliberately: capacity comes from
            // the synced host inventory, so a non-zero baseline double-counts it.
            baselineCapacity: 0,
          },
        },
      },
    });

    const res = await server.inject({ method: 'GET', url: `/api/clusters/${cluster.id}` });
    expect(res.statusCode).toBe(200);
    const body = clusterResponseSchema.parse(res.json());

    expect(body.metrics).toHaveLength(1);
    expect(body.metrics[0]?.metricTypeKey).toBe('memory_gb');
    expect(body.metrics[0]?.baselineConsumption).toBe(4000);
    expect(body.source).toBe('vsphere');

    // ...and the list endpoint agrees, since it is the same derivation.
    const list = await server.inject({ method: 'GET', url: '/api/clusters?limit=100' });
    const listed = (list.json() as { items: Array<{ id: string; metrics: unknown[] }> }).items.find(
      (c) => c.id === cluster.id,
    );
    expect(listed?.metrics).toHaveLength(1);
  });

  it('falls back to createdAt — never today — when a cluster has no history at all', async () => {
    // A synced cluster between import and its first monthly snapshot. Reporting
    // today here would render a never-measured cluster as "baselined today":
    // maximally fresh, tripping no staleness check, on a cluster nobody has
    // measured. Same fail-open class as the forbidden `utilization ?? 0`.
    const cluster = await prisma.cluster.create({
      data: {
        tenantId: 'default',
        name: uniqueName('no-history'),
        source: 'vsphere',
      },
    });
    await prisma.cluster.update({
      where: { id: cluster.id },
      data: { createdAt: new Date(Date.UTC(2025, 10, 20)) },
    });

    const res = await server.inject({ method: 'GET', url: `/api/clusters/${cluster.id}` });
    expect(res.statusCode).toBe(200);
    const body = clusterResponseSchema.parse(res.json());

    expect(body.metrics).toEqual([]);
    // The 20th snapped to the 1st: `ClusterResponse.baselineDate` is documented
    // as ALWAYS first-of-month, and `createdAt` is a full timestamp. Emitting the
    // raw day here makes the fallback the one value in the contract that breaks
    // it, and it is the only branch a consumer parsing `YYYY-MM` can hit. Snapping
    // also errs old, never fresh — the safe direction for a staleness signal.
    expect(body.baselineDate).toBe('2025-11-01');
    expect(body.baselineDate.endsWith('-01')).toBe(true);
    expect(body.baselineDate).not.toBe(new Date().toISOString().slice(0, 10));
  });

  it('absorbs a delta already inside a vSphere baseline, agreeing with /forecast', async () => {
    // A vSphere snapshot measures TOTAL actual usage, so a tracked delta dated at
    // or before the capture is already inside the number and adding it again
    // double-counts (forecast.ts `absorbed`, recorded decision Q9b). /forecast has
    // always applied that rule because forecast-loader passes `baselineSource`;
    // the cluster endpoints did not, because `metrics` came from a legacy table
    // that has no `source` column. Reading both from the same history row
    // converges them — a deliberate, purchasing-visible change, argued in the PR.
    const metric = await prisma.metricType.findUniqueOrThrow({ where: { key: 'memory_gb' } });
    const cluster = await prisma.cluster.create({
      data: {
        tenantId: 'default',
        name: uniqueName('vsphere-absorb'),
        source: 'vsphere',
        baselineHistory: {
          create: {
            tenantId: 'default',
            metricTypeId: metric.id,
            capturedAt: new Date(Date.UTC(2026, 4, 1)),
            source: 'vsphere',
            baselineConsumption: 4000,
            baselineCapacity: 8192,
          },
        },
      },
    });
    await makeEvent(prisma, {
      clusterId: cluster.id,
      title: uniqueName('absorbed-event'),
      effectiveDate: new Date(Date.UTC(2026, 3, 1)), // April: BEFORE the May capture
      consumptionDelta: 500,
    });

    const res = await server.inject({ method: 'GET', url: `/api/clusters/${cluster.id}` });
    const body = clusterResponseSchema.parse(res.json());
    // 4000, not 4500: April's delta is already inside May's measurement.
    expect(body.metrics[0]?.currentConsumption).toBe(4000);

    const month = new Date().toISOString().slice(0, 7);
    const forecast = await server.inject({
      method: 'GET',
      url: `/api/clusters/${cluster.id}/forecast?metric=memory_gb&from=${month}&to=${month}`,
    });
    expect(forecast.statusCode).toBe(200);
    const fc = forecast.json() as { months: Array<{ consumption: number }> };
    expect(fc.months[0]?.consumption).toBe(body.metrics[0]?.currentConsumption);
  });

  it('does NOT absorb a pre-baseline delta on a manual cluster', async () => {
    // The other half of Q9b, asserted so the `baselineSource` pass-through cannot
    // be "simplified" to a constant. A manual baseline is the portion NOT modelled
    // by tracked entities (vision.md Invariant 1), so a tracked delta is never
    // inside it regardless of date.
    const cluster = await makeCluster(prisma, {
      name: uniqueName('manual-no-absorb'),
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 4000,
      baselineCapacity: 8192,
    });
    await makeEvent(prisma, {
      clusterId: cluster.id,
      title: uniqueName('unabsorbed-event'),
      effectiveDate: new Date(Date.UTC(2026, 3, 1)),
      consumptionDelta: 500,
    });

    const res = await server.inject({ method: 'GET', url: `/api/clusters/${cluster.id}` });
    const body = clusterResponseSchema.parse(res.json());
    expect(body.metrics[0]?.currentConsumption).toBe(4500);
  });
});

describe('PUT /api/clusters/:id — a date-only edit re-anchors baseline history', () => {
  it('re-dates each metric’s newest row in place, inventing and destroying nothing', async () => {
    const cluster = await makeCluster(prisma, {
      name: uniqueName('reanchor'),
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 100,
      baselineCapacity: 1000,
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-06-01' },
    });
    expect(res.statusCode).toBe(200);
    // The response echoes the submitted date, so the edit does not silently
    // revert in the baseline form (which resets its input from the response).
    expect(clusterResponseSchema.parse(res.json()).baselineDate).toBe('2026-06-01');

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capturedAt.toISOString().slice(0, 10)).toBe('2026-06-01');
    // Re-dated, not re-measured: the recorded numbers are untouched.
    expect(rows[0]?.baselineConsumption.toNumber()).toBe(100);
  });

  it('refuses with 422 BASELINE_PERIOD_OCCUPIED rather than overwriting a recorded period', async () => {
    const cluster = await makeCluster(prisma, {
      name: uniqueName('occupied'),
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 100,
      baselineCapacity: 1000,
      extraBaselines: [
        {
          metricKey: 'memory_gb',
          capturedAt: new Date(Date.UTC(2026, 6, 1)),
          baselineConsumption: 300,
          baselineCapacity: 1000,
        },
      ],
    });

    // The newest row is July; May is already taken. Re-dating July onto May would
    // have to destroy an append-only measurement, so it is refused instead.
    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-05-01' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BASELINE_PERIOD_OCCUPIED');
    // Refused by the CHECK, which can name the metric and the period to edit
    // instead. Without the check the write still fails — the unique index sees to
    // that — but only as a P2002 mapped to the same code with an "in flight,
    // reload and retry" message, which is a lie about a deterministic conflict
    // that no amount of retrying resolves. This is what pins `capturedAt >= target`
    // as the guard's comparison rather than `>`.
    expect(body.error.message).toContain('memory_gb');
    expect(body.error.message).toContain('2026-05');

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
      orderBy: { capturedAt: 'asc' },
    });
    expect(rows.map((r) => r.capturedAt.toISOString().slice(0, 10))).toEqual([
      '2026-05-01',
      '2026-07-01',
    ]);
    expect(rows.map((r) => r.baselineConsumption.toNumber())).toEqual([100, 300]);
  });

  it('refuses a re-date that would land BEFORE an older row for the same metric', async () => {
    const cluster = await makeCluster(prisma, {
      name: uniqueName('reorder-backwards'),
      baselineDate: new Date(Date.UTC(2026, 4, 1)), // May, 100
      baselineConsumption: 100,
      baselineCapacity: 1000,
      extraBaselines: [
        {
          metricKey: 'memory_gb',
          capturedAt: new Date(Date.UTC(2026, 6, 1)), // July, 300 — the newest
          baselineConsumption: 300,
          baselineCapacity: 1000,
        },
      ],
    });

    // April is UNOCCUPIED, so a refusal phrased as "is the target period taken?"
    // waves this through and re-dates July's 300 to April. History then reads
    // Apr=300, May=100: the July measurement plotted at April, and a fabricated
    // 300 -> 100 drop on the chart that no measurement ever recorded. The
    // response contradicts the request too — baselineDate is MIN over
    // newest-per-metric, so it would answer 2026-05-01 to a submitted
    // 2026-04-01, and baseline-edit-form.tsx resets its input from the response
    // onto a third date the operator never typed.
    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-04-01' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('BASELINE_PERIOD_OCCUPIED');

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
      orderBy: { capturedAt: 'asc' },
    });
    expect(rows.map((r) => r.capturedAt.toISOString().slice(0, 10))).toEqual([
      '2026-05-01',
      '2026-07-01',
    ]);
    expect(rows.map((r) => r.baselineConsumption.toNumber())).toEqual([100, 300]);
  });

  it('allows a re-date onto a period later than every other row for that metric', async () => {
    // The other half of the ordering guard. Moving the newest row FORWARD past
    // nothing keeps history in order, so it must still succeed — a guard that
    // refused whenever the metric held more than one row would break the ordinary
    // "the last capture was actually taken in August" correction.
    const cluster = await makeCluster(prisma, {
      name: uniqueName('reorder-forwards'),
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 100,
      baselineCapacity: 1000,
      extraBaselines: [
        {
          metricKey: 'memory_gb',
          capturedAt: new Date(Date.UTC(2026, 6, 1)),
          baselineConsumption: 300,
          baselineCapacity: 1000,
        },
      ],
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-08-01' },
    });
    expect(res.statusCode).toBe(200);
    expect(clusterResponseSchema.parse(res.json()).baselineDate).toBe('2026-08-01');

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
      orderBy: { capturedAt: 'asc' },
    });
    // Re-dated, not appended: still two rows, the older one untouched.
    expect(rows.map((r) => r.capturedAt.toISOString().slice(0, 10))).toEqual([
      '2026-05-01',
      '2026-08-01',
    ]);
    expect(rows.map((r) => r.baselineConsumption.toNumber())).toEqual([100, 300]);
  });

  it('is not blocked by a DIFFERENT metric already occupying the target period', async () => {
    // The occupancy check is per metric, because the unique key is
    // (cluster, metric, period). A cluster-wide "is that period taken?" check
    // would look simpler and would refuse this legitimate edit: memory already
    // sits on the target, and moving cpu onto it conflicts with nothing.
    await prisma.metricType.upsert({
      where: { key: 'cpu_cores_195e' },
      update: {},
      create: { key: 'cpu_cores_195e', displayName: 'CPU (test)', unit: 'cores' },
    });
    const cluster = await makeCluster(prisma, {
      name: uniqueName('per-metric-occupancy'),
      baselineDate: new Date(Date.UTC(2026, 5, 1)), // memory already at June
      baselineConsumption: 100,
      baselineCapacity: 1000,
      extraBaselines: [
        {
          metricKey: 'cpu_cores_195e',
          capturedAt: new Date(Date.UTC(2026, 4, 1)), // cpu at May, must move
          baselineConsumption: 8,
          baselineCapacity: 64,
        },
      ],
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-06-01' },
    });
    expect(res.statusCode).toBe(200);

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.capturedAt.toISOString().slice(0, 10) === '2026-06-01')).toBe(true);
  });

  it('is a no-op on a cluster with no baseline history', async () => {
    // A synced cluster before its first snapshot has nothing to re-date. It must
    // not fabricate a measurement nobody took just to honour the submitted date.
    const cluster = await prisma.cluster.create({
      data: {
        tenantId: 'default',
        name: uniqueName('reanchor-empty'),
        source: 'vsphere',
      },
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-06-01' },
    });
    expect(res.statusCode).toBe(200);
    expect(await prisma.clusterBaselineHistory.count({ where: { clusterId: cluster.id } })).toBe(0);
  });

  it('re-anchors and renames in one request', async () => {
    const cluster = await makeCluster(prisma, {
      name: uniqueName('reanchor-rename'),
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 100,
      baselineCapacity: 1000,
    });
    const renamed = uniqueName('renamed');

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { name: renamed, baselineDate: '2026-06-01' },
    });
    expect(res.statusCode).toBe(200);
    const body = clusterResponseSchema.parse(res.json());
    expect(body.name).toBe(renamed);
    expect(body.baselineDate).toBe('2026-06-01');
  });

  it('maps a period collision the pre-check could not see to 422, not 500', async () => {
    // `planBaselineReanchor` reads occupancy OUTSIDE the transaction that writes,
    // so a row can appear at the target period in between. The Postgres unique
    // index is the real guard and nothing corrupts — but the operator should get
    // the same typed refusal as the checked path rather than a sanitized 500 with
    // no indication of which period to edit instead.
    //
    // The state is materialized deterministically rather than raced: the
    // pre-check is tenant-scoped while `cluster_baseline_history_period_unique`
    // is (cluster, metric, period) only, so a history row carrying a different
    // tenant is invisible to the check and still collides at write time — the
    // same DB state a concurrent writer produces between the check and the write.
    await prisma.tenant.upsert({
      where: { id: 'toctou-tenant' },
      update: {},
      create: { id: 'toctou-tenant', name: 'Other tenant' },
    });
    const metric = await prisma.metricType.findUniqueOrThrow({ where: { key: 'memory_gb' } });
    const cluster = await makeCluster(prisma, {
      name: uniqueName('toctou'),
      baselineDate: new Date(Date.UTC(2026, 5, 1)), // June
      baselineConsumption: 100,
      baselineCapacity: 1000,
    });
    await prisma.clusterBaselineHistory.create({
      data: {
        clusterId: cluster.id,
        tenantId: 'toctou-tenant',
        metricTypeId: metric.id,
        capturedAt: new Date(Date.UTC(2026, 4, 1)), // May — unseen by the check
        source: 'manual',
        baselineConsumption: new Prisma.Decimal(1),
        baselineCapacity: new Prisma.Decimal(2),
      },
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-05-01' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('BASELINE_PERIOD_OCCUPIED');
  });
});

describe('PUT /api/clusters/:id — a combined date + values edit', () => {
  /**
   * The PRIMARY path out of baseline-edit-form.tsx: `handleConfirm` sets
   * `baselineDate` under `if (dateChanged)` and `baselines` under
   * `if (baselinesChanged)` from two independent dirty checks, so correcting the
   * date and a number in one save sends both fields.
   *
   * Locked semantics: the re-anchor runs FIRST (ordering guard included), then
   * the submitted values are applied at the target period. A combined edit is a
   * CORRECTION of the newest measurement — one row ends up at the submitted
   * period carrying the submitted values, and the response echoes both.
   */
  it('moves the row to the submitted period AND applies the values, echoing both', async () => {
    const cluster = await makeCluster(prisma, {
      name: uniqueName('combined'),
      baselineDate: new Date(Date.UTC(2026, 5, 1)), // June, 100
      baselineConsumption: 100,
      baselineCapacity: 1000,
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: {
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 150, baselineCapacity: 1000 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    // The response echoes BOTH edits. Neither may silently revert: the form
    // resets its inputs from this body, so a stale echo is the operator watching
    // a confirmed, successful save undo itself.
    const body = clusterResponseSchema.parse(res.json());
    expect(body.baselineDate).toBe('2026-05-01');
    expect(body.metrics[0]?.baselineConsumption).toBe(150);
    expect(body.metrics[0]?.baselineCapacity).toBe(1000);

    // ONE row — the June row moved, not a second row appended beside it. A
    // leftover June row would both keep the stale 100 as newest-per-metric and
    // draw a measurement nobody took onto the history chart.
    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capturedAt.toISOString().slice(0, 10)).toBe('2026-05-01');
    expect(rows[0]?.baselineConsumption.toNumber()).toBe(150);
  });

  it('refuses with 422 when the combined edit would reorder history', async () => {
    const cluster = await makeCluster(prisma, {
      name: uniqueName('combined-reorder'),
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 100,
      baselineCapacity: 1000,
      extraBaselines: [
        {
          metricKey: 'memory_gb',
          capturedAt: new Date(Date.UTC(2026, 6, 1)),
          baselineConsumption: 300,
          baselineCapacity: 1000,
        },
      ],
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: {
        baselineDate: '2026-04-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 150, baselineCapacity: 1000 },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('BASELINE_PERIOD_OCCUPIED');

    // Refused means nothing was written — not the values either.
    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
      orderBy: { capturedAt: 'asc' },
    });
    expect(rows.map((r) => r.capturedAt.toISOString().slice(0, 10))).toEqual([
      '2026-05-01',
      '2026-07-01',
    ]);
    expect(rows.map((r) => r.baselineConsumption.toNumber())).toEqual([100, 300]);
  });

  it('refuses with 422 when the combined edit targets an occupied period', async () => {
    const cluster = await makeCluster(prisma, {
      name: uniqueName('combined-occupied'),
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 100,
      baselineCapacity: 1000,
      extraBaselines: [
        {
          metricKey: 'memory_gb',
          capturedAt: new Date(Date.UTC(2026, 6, 1)),
          baselineConsumption: 300,
          baselineCapacity: 1000,
        },
      ],
    });

    // May holds a recorded measurement. Landing July's row on it would overwrite
    // that measurement with July's numbers — silently, on data that buys
    // hardware — so the whole request is refused rather than merged.
    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: {
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 150, baselineCapacity: 1000 },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BASELINE_PERIOD_OCCUPIED');
    // Refused by the check, naming the metric and period — see the date-only
    // occupancy test for why the message, not just the code, is asserted.
    expect(body.error.message).toContain('memory_gb');

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
      orderBy: { capturedAt: 'asc' },
    });
    expect(rows.map((r) => r.baselineConsumption.toNumber())).toEqual([100, 300]);
  });

  it('appends rather than re-dating when the submitted period is later', async () => {
    // The other direction, and the reason the re-anchor cannot simply run for
    // every metric on every dated request: a value at a LATER period is an
    // ordinary new monthly measurement. Appending it keeps the older one, which is
    // the accumulation epic #172 exists for; re-dating instead would delete a
    // measurement on every forward-dated save.
    const cluster = await makeCluster(prisma, {
      name: uniqueName('combined-forward'),
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 100,
      baselineCapacity: 1000,
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: {
        baselineDate: '2026-06-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 150, baselineCapacity: 1000 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(clusterResponseSchema.parse(res.json()).baselineDate).toBe('2026-06-01');

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
      orderBy: { capturedAt: 'asc' },
    });
    expect(rows.map((r) => r.capturedAt.toISOString().slice(0, 10))).toEqual([
      '2026-05-01',
      '2026-06-01',
    ]);
    expect(rows.map((r) => r.baselineConsumption.toNumber())).toEqual([100, 150]);
  });

  it('leaves a metric the payload omitted untouched while re-dating the named one', async () => {
    // #181's rule — an omitted metric must be untouched — applies to the re-date
    // as much as to the values. Re-anchoring every metric on the cluster would
    // silently move a row the payload never described, which is the same silent
    // edit that rule exists to prevent.
    await prisma.metricType.upsert({
      where: { key: 'cpu_cores_195f' },
      update: {},
      create: { key: 'cpu_cores_195f', displayName: 'CPU (test)', unit: 'cores' },
    });
    const cluster = await makeCluster(prisma, {
      name: uniqueName('combined-omitted'),
      baselineDate: new Date(Date.UTC(2026, 5, 1)), // memory at June
      baselineConsumption: 100,
      baselineCapacity: 1000,
      extraBaselines: [
        {
          metricKey: 'cpu_cores_195f',
          capturedAt: new Date(Date.UTC(2026, 6, 1)), // cpu at July
          baselineConsumption: 32,
          baselineCapacity: 128,
        },
      ],
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: {
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 150, baselineCapacity: 1000 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
      include: { metricType: { select: { key: true } } },
      orderBy: { capturedAt: 'asc' },
    });
    expect(rows.map((r) => [r.metricType.key, r.capturedAt.toISOString().slice(0, 10)])).toEqual([
      ['memory_gb', '2026-05-01'],
      ['cpu_cores_195f', '2026-07-01'],
    ]);
    // cpu keeps both its period and its numbers.
    expect(rows[1]?.baselineConsumption.toNumber()).toBe(32);
  });

  it('still lands a values-only edit on the newest recorded period', async () => {
    // The un-combined path, pinned so restructuring the branch cannot quietly
    // change it: no date submitted means the correction lands on the period it is
    // correcting, updating in place rather than appending a competing row.
    const cluster = await makeCluster(prisma, {
      name: uniqueName('values-only'),
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 100,
      baselineCapacity: 1000,
      extraBaselines: [
        {
          metricKey: 'memory_gb',
          capturedAt: new Date(Date.UTC(2026, 6, 1)),
          baselineConsumption: 300,
          baselineCapacity: 1000,
        },
      ],
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: {
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 350, baselineCapacity: 1000 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
      orderBy: { capturedAt: 'asc' },
    });
    expect(rows.map((r) => r.capturedAt.toISOString().slice(0, 10))).toEqual([
      '2026-05-01',
      '2026-07-01',
    ]);
    expect(rows.map((r) => r.baselineConsumption.toNumber())).toEqual([100, 350]);
  });
});
