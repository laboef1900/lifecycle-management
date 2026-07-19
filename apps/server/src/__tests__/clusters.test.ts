import { clusterResponseSchema } from '@lcm/shared';
import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { makeCluster, makeEvent, makeHost } from './factories.js';
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

  it('reports a metric listed twice as such, never as a name conflict', async () => {
    // `clusterCreateInputSchema` bounds `baselines` by length alone, so naming one
    // metric twice is a legal payload — and it writes two nested history rows at
    // the same (cluster, metric, period), violating
    // `cluster_baseline_history_period_unique` rather than the cluster-name index.
    // Two unique indexes are reachable from this one statement, so mapping every
    // P2002 to CLUSTER_NAME_TAKEN answers a question the operator did not ask:
    // it reports a name collision that does not exist, and no rename ever
    // resolves it, so the only available response is to retry with new names
    // forever.
    const name = uniqueName('dup-metric');
    const res = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name,
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
          { metricTypeKey: 'memory_gb', baselineConsumption: 200, baselineCapacity: 2000 },
        ],
      },
    });

    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).not.toBe('CLUSTER_NAME_TAKEN');
    expect(res.statusCode).toBe(422);
    expect(body.error.code).toBe('BASELINE_PERIOD_OCCUPIED');
    // Names the metric, because with up to 50 baselines in a payload "one of them
    // is duplicated" is not something the operator can act on.
    expect(body.error.message).toContain('memory_gb');

    // ...and the name really was free the whole time — the nested create is one
    // statement, so the refusal left nothing behind. This is what makes the old
    // answer a lie rather than merely an imprecise one.
    expect(await prisma.cluster.count({ where: { name } })).toBe(0);
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
    // BACKWARDS, which is the only direction a date-only edit can express: the
    // measurement exists, it is simply anchored later than the period the operator
    // says it was captured in. (Forward has nothing to move onto the target and is
    // refused — see the FORWARD describe block below.)
    const cluster = await makeCluster(prisma, {
      name: uniqueName('reanchor'),
      baselineDate: new Date(Date.UTC(2026, 5, 1)), // June
      baselineConsumption: 100,
      baselineCapacity: 1000,
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-05-01' },
    });
    expect(res.statusCode).toBe(200);
    // The response echoes the submitted date, so the edit does not silently
    // revert in the baseline form (which resets its input from the response).
    expect(clusterResponseSchema.parse(res.json()).baselineDate).toBe('2026-05-01');

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capturedAt.toISOString().slice(0, 10)).toBe('2026-05-01');
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

  it('allows a re-date onto a free period that no OLDER row blocks', async () => {
    // The permissive half of the ordering guard. The blocking query asks for rows
    // at or after the target, so an older row must NOT stop the move — a guard
    // that refused whenever the metric held more than one row would reject every
    // correction on a cluster with any accumulated history, which is every cluster
    // epic #172 has been running against.
    const cluster = await makeCluster(prisma, {
      name: uniqueName('reorder-free-period'),
      baselineDate: new Date(Date.UTC(2026, 4, 1)), // May, 100 — older, must not block
      baselineConsumption: 100,
      baselineCapacity: 1000,
      extraBaselines: [
        {
          metricKey: 'memory_gb',
          capturedAt: new Date(Date.UTC(2026, 6, 1)), // July, 300 — the newest, moves
          baselineConsumption: 300,
          baselineCapacity: 1000,
        },
      ],
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-06-01' },
    });
    expect(res.statusCode).toBe(200);
    expect(clusterResponseSchema.parse(res.json()).baselineDate).toBe('2026-06-01');

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
      orderBy: { capturedAt: 'asc' },
    });
    // Re-dated, not appended: still two rows, the older one untouched, and history
    // still reads in order (May=100 then June=300).
    expect(rows.map((r) => r.capturedAt.toISOString().slice(0, 10))).toEqual([
      '2026-05-01',
      '2026-06-01',
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
      baselineDate: new Date(Date.UTC(2026, 4, 1)), // memory already ON the target
      baselineConsumption: 100,
      baselineCapacity: 1000,
      extraBaselines: [
        {
          metricKey: 'cpu_cores_195e',
          capturedAt: new Date(Date.UTC(2026, 6, 1)), // cpu at July, must move back
          baselineConsumption: 8,
          baselineCapacity: 64,
        },
      ],
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-05-01' },
    });
    expect(res.statusCode).toBe(200);

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.capturedAt.toISOString().slice(0, 10) === '2026-05-01')).toBe(true);
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
      baselineDate: new Date(Date.UTC(2026, 5, 1)), // June
      baselineConsumption: 100,
      baselineCapacity: 1000,
    });
    const renamed = uniqueName('renamed');

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { name: renamed, baselineDate: '2026-05-01' },
    });
    expect(res.statusCode).toBe(200);
    const body = clusterResponseSchema.parse(res.json());
    expect(body.name).toBe(renamed);
    expect(body.baselineDate).toBe('2026-05-01');
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

/**
 * The FORWARD half of the date-only re-anchor, which the first cut of #195 let
 * through unconstrained: `writing === undefined` returned true for every newest
 * row in any direction, contradicting the docstring one screen above it.
 *
 * A date-only request carries no values. Backwards there is still something
 * honest to do — the metric's newest row is at a period later than the one the
 * operator says it was captured in, and appending is impossible, so it is
 * re-dated. FORWARDS there is nothing: no value to append, and re-dating drags a
 * measurement onto a month nobody measured. Three consequences follow from the
 * move, all silent and all pointing the same way — towards deferring hardware
 * that is actually needed:
 *
 *   1. The move writes `capturedAt` only, so `source: 'vsphere'` survives, and
 *      forecast.ts `absorbed` treats everything dated at or before the new
 *      anchor as already inside the measurement. Deltas that started AFTER the
 *      capture are erased from the forecast.
 *   2. The moved row occupies the current period, and VsphereSnapshotService
 *      writes with `skipDuplicates` — so the month's real vCenter measurement is
 *      dropped and last month's number is recorded as this month's.
 *   3. On a multi-metric cluster the snapshot job writes memory_gb only, so a
 *      second metric lags by design. Dragging its untouched row forward destroys
 *      the period it was actually measured in and flips the cluster from stale
 *      to fresh without measuring anything.
 *
 * So it is REFUSED, per request, rather than silently no-opped: a no-op returns
 * 200 with a response echoing neither the submitted date nor anything else, and
 * baseline-edit-form.tsx resets its input from that response — the exact silent
 * revert the re-anchor exists to prevent.
 */
describe('PUT /api/clusters/:id — a FORWARD date-only edit is refused, not fabricated', () => {
  it('refuses with 422 BASELINE_PERIOD_NOT_MEASURED and writes nothing', async () => {
    const cluster = await makeCluster(prisma, {
      name: uniqueName('forward-refused'),
      baselineDate: new Date(Date.UTC(2026, 4, 1)), // May, 100
      baselineConsumption: 100,
      baselineCapacity: 1000,
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-06-01' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BASELINE_PERIOD_NOT_MEASURED');
    // Names the offending metric and the period, and states the honest
    // alternative — the operator's next action is to submit the values for June,
    // which appends a measurement instead of moving one.
    expect(body.error.message).toContain('memory_gb');
    expect(body.error.message).toContain('2026-06');
    expect(body.error.message).toMatch(/submit the values/iu);

    // Not moved, not copied, not appended.
    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capturedAt.toISOString().slice(0, 10)).toBe('2026-05-01');
    expect(rows[0]?.baselineConsumption.toNumber()).toBe(100);
  });

  it('refuses the WHOLE request when one metric of several would move forward', async () => {
    // The partial-application trap. memory may legitimately move (July -> June),
    // cpu may not (May -> June). Applying the half that is legal leaves the
    // response reporting a baselineDate — MIN over newest-per-metric — of
    // 2026-05-01 for a request that submitted 2026-06-01, so the form resets the
    // operator's edit away with a 200 OK. Refusing the request is the only answer
    // that is not a silent partial write.
    await prisma.metricType.upsert({
      where: { key: 'cpu_cores_195f' },
      update: {},
      create: { key: 'cpu_cores_195f', displayName: 'CPU (test)', unit: 'cores' },
    });
    const cluster = await makeCluster(prisma, {
      name: uniqueName('forward-partial'),
      baselineDate: new Date(Date.UTC(2026, 6, 1)), // memory at July — may move back
      baselineConsumption: 300,
      baselineCapacity: 1000,
      extraBaselines: [
        {
          metricKey: 'cpu_cores_195f',
          capturedAt: new Date(Date.UTC(2026, 4, 1)), // cpu at May — would move FORWARD
          baselineConsumption: 32,
          baselineCapacity: 128,
        },
      ],
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-06-01' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BASELINE_PERIOD_NOT_MEASURED');
    expect(body.error.message).toContain('cpu_cores_195f');

    // NEITHER metric moved — not even the one whose move was legal.
    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
      orderBy: { capturedAt: 'asc' },
    });
    expect(rows.map((r) => r.capturedAt.toISOString().slice(0, 10))).toEqual([
      '2026-05-01',
      '2026-07-01',
    ]);
  });

  it('refuses the rename that rides along, rather than half-applying the request', async () => {
    // `cluster.update` runs in the same transaction as the moves, and the refusal
    // is raised while the write list is still being planned — so a rename bundled
    // with an impossible date is refused with it. The operator sees one failure
    // for one request instead of a name that changed and a date that did not.
    const original = uniqueName('forward-rename');
    const cluster = await makeCluster(prisma, {
      name: original,
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 100,
      baselineCapacity: 1000,
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { name: uniqueName('forward-renamed'), baselineDate: '2026-06-01' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'BASELINE_PERIOD_NOT_MEASURED',
    );

    const after = await prisma.cluster.findUniqueOrThrow({ where: { id: cluster.id } });
    expect(after.name).toBe(original);
  });

  it('never silently drops a synced cluster’s forecast consumption (consequence 1)', async () => {
    // The traced regression, end to end. The cluster is vSphere-sourced and its
    // April measurement is 1000; a growth event lands in May, AFTER the capture,
    // so it is correctly outside the measurement and the forecast reads 1500.
    //
    // Under the unconstrained forward move the row was re-dated to June with
    // `source: 'vsphere'` intact, `absorbed` swallowed the May event, and
    // currentConsumption silently fell back to 1000 — 500 GB of real, growing
    // consumption erased from the number that decides when hardware is bought.
    const metric = await prisma.metricType.findUniqueOrThrow({ where: { key: 'memory_gb' } });
    const cluster = await prisma.cluster.create({
      data: {
        tenantId: 'default',
        name: uniqueName('forward-underreport'),
        source: 'vsphere',
        baselineHistory: {
          create: {
            tenantId: 'default',
            metricTypeId: metric.id,
            capturedAt: new Date(Date.UTC(2026, 3, 1)), // April
            source: 'vsphere',
            baselineConsumption: 1000,
            baselineCapacity: 5000,
          },
        },
      },
    });
    await makeEvent(prisma, {
      clusterId: cluster.id,
      title: uniqueName('post-capture-growth'),
      effectiveDate: new Date(Date.UTC(2026, 4, 1)), // May: AFTER the April capture
      consumptionDelta: 500,
    });

    const before = clusterResponseSchema.parse(
      (await server.inject({ method: 'GET', url: `/api/clusters/${cluster.id}` })).json(),
    );
    expect(before.metrics[0]?.currentConsumption).toBe(1500);

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-06-01' },
    });
    expect(res.statusCode).toBe(422);

    const after = clusterResponseSchema.parse(
      (await server.inject({ method: 'GET', url: `/api/clusters/${cluster.id}` })).json(),
    );
    // The whole point: consumption did not fall, and utilization did not improve.
    expect(after.metrics[0]?.currentConsumption).toBe(1500);
    expect(after.metrics[0]?.currentConsumption).not.toBe(1000);
    expect(after.metrics[0]?.utilization).toBe(before.metrics[0]?.utilization);

    // The vCenter measurement is still where vCenter took it, still labelled as
    // measured — so next month's snapshot writes into a free period (consequence
    // 2) and the cluster's staleness still reflects when it was last measured
    // (consequence 3).
    const rows = await prisma.clusterBaselineHistory.findMany({ where: { clusterId: cluster.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capturedAt.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(rows[0]?.source).toBe('vsphere');
  });
});

describe('PUT /api/clusters/:id — a re-dated row keeps its provenance', () => {
  it('re-dates a vSphere row WITHOUT relabelling it manual', async () => {
    // Q9a keeps baselineDate corrections OPEN on a synced cluster, so the edit is
    // allowed. A move re-dates a measurement; it does not re-measure it, so the
    // values are still vCenter's and `source` stays `vsphere`.
    //
    // An earlier revision flipped it to `manual` here. That is not a cosmetic
    // difference: `absorbed` in forecast.ts is SOURCE-GATED, so the flip stops it
    // absorbing anything at all — including deltas dated before the new anchor,
    // which the measurement genuinely contains. The sibling test below pins the
    // purchasing-visible consequence.
    const metric = await prisma.metricType.findUniqueOrThrow({ where: { key: 'memory_gb' } });
    const cluster = await prisma.cluster.create({
      data: {
        tenantId: 'default',
        name: uniqueName('moved-source'),
        source: 'vsphere',
        baselineHistory: {
          create: {
            tenantId: 'default',
            metricTypeId: metric.id,
            capturedAt: new Date(Date.UTC(2026, 5, 1)), // June
            source: 'vsphere',
            baselineConsumption: 1000,
            baselineCapacity: 5000,
          },
        },
      },
    });
    await makeEvent(prisma, {
      clusterId: cluster.id,
      title: uniqueName('pre-capture-growth'),
      effectiveDate: new Date(Date.UTC(2026, 4, 1)), // May: absorbed while the anchor is vSphere
      consumptionDelta: 500,
    });

    const before = clusterResponseSchema.parse(
      (await server.inject({ method: 'GET', url: `/api/clusters/${cluster.id}` })).json(),
    );
    expect(before.metrics[0]?.currentConsumption).toBe(1000); // absorbed

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-04-01' }, // backwards: allowed
    });
    expect(res.statusCode).toBe(200);

    const rows = await prisma.clusterBaselineHistory.findMany({ where: { clusterId: cluster.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capturedAt.toISOString().slice(0, 10)).toBe('2026-04-01');
    // The assertion this test exists for: the period a human chose, the
    // provenance vCenter earned. Two separate facts about one row.
    expect(rows[0]?.source).toBe('vsphere');

    // ...and the forecast follows the DATE, which is what moved: May is now after
    // the anchor, so its event is no longer inside the measurement and is counted.
    // The number errs high, never low.
    const after = clusterResponseSchema.parse(
      (await server.inject({ method: 'GET', url: `/api/clusters/${cluster.id}` })).json(),
    );
    expect(after.metrics[0]?.currentConsumption).toBe(1500);
    expect(after.metrics[0]?.baselineConsumption).toBe(1000); // re-dated, never re-measured
  });

  it('leaves utilization untouched when a pre-target capacityDelta stays absorbed', async () => {
    // The asymmetry that let the source flip through review. Every earlier test
    // here exercises a consumptionDelta, where un-absorbing errs HIGH — more
    // consumption counted, hardware ordered sooner, the safe direction. A
    // capacityDelta errs the other way: un-absorbing it invents capacity, and
    // utilization FALLS with nothing measured and no value submitted. That is the
    // defer-hardware direction the re-anchor guard exists to prevent.
    //
    // Under the flip, `absorbed` went source-gated-false for everything, so
    // March's +500 GB — already inside June's measurement, and still inside
    // April's — was re-added and 50% utilization read as 40%.
    const metric = await prisma.metricType.findUniqueOrThrow({ where: { key: 'memory_gb' } });
    const cluster = await prisma.cluster.create({
      data: {
        tenantId: 'default',
        name: uniqueName('reanchor-capacity'),
        source: 'vsphere',
        baselineHistory: {
          create: {
            tenantId: 'default',
            metricTypeId: metric.id,
            capturedAt: new Date(Date.UTC(2026, 5, 1)), // June
            source: 'vsphere',
            baselineConsumption: 1000,
            // Zero by the Q9a invariant: on a synced cluster the hosts ARE the
            // capacity, so the scalar must not double-count them.
            baselineCapacity: 0,
          },
        },
      },
    });
    await makeHost(prisma, {
      clusterId: cluster.id,
      name: uniqueName('reanchor-capacity-host'),
      commissionedAt: new Date(Date.UTC(2026, 0, 1)),
      initialCapacity: [{ effectiveFrom: new Date(Date.UTC(2026, 0, 1)), amount: 2000 }],
    });
    await makeEvent(prisma, {
      clusterId: cluster.id,
      title: uniqueName('pre-target-capacity'),
      effectiveDate: new Date(Date.UTC(2026, 2, 1)), // March: before BOTH anchors
      consumptionDelta: null,
      capacityDelta: 500,
    });

    const before = clusterResponseSchema.parse(
      (await server.inject({ method: 'GET', url: `/api/clusters/${cluster.id}` })).json(),
    );
    expect(before.metrics[0]?.currentCapacity).toBe(2000);
    expect(before.metrics[0]?.utilization).toBe(0.5);

    // A pure date edit. No measurement was taken and no value was submitted, so
    // no number on this cluster may move.
    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: { baselineDate: '2026-04-01' }, // backwards, and still after March
    });
    expect(res.statusCode).toBe(200);

    const after = clusterResponseSchema.parse(
      (await server.inject({ method: 'GET', url: `/api/clusters/${cluster.id}` })).json(),
    );
    expect(after.metrics[0]?.currentCapacity).toBe(2000);
    expect(after.metrics[0]?.utilization).toBe(0.5);
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

  it('lands a values-only edit on EACH metric’s own newest period, never a cluster-wide one', async () => {
    // The test above holds ONE metric, under which "this metric's newest period"
    // and "the cluster's newest period" are the same date — so it cannot tell the
    // two apart. Here they have DIVERGED, which is the normal state rather than a
    // contrived one: the vSphere snapshot job writes memory_gb only, so any
    // second metric falls behind the moment the job runs.
    await prisma.metricType.upsert({
      where: { key: 'cpu_cores_195g' },
      update: {},
      create: { key: 'cpu_cores_195g', displayName: 'CPU (test)', unit: 'cores' },
    });
    const cluster = await makeCluster(prisma, {
      name: uniqueName('values-only-diverged'),
      baselineDate: new Date(Date.UTC(2026, 4, 1)), // memory at May, 150
      baselineConsumption: 150,
      baselineCapacity: 1000,
      extraBaselines: [
        {
          metricKey: 'cpu_cores_195g',
          capturedAt: new Date(Date.UTC(2026, 6, 1)), // cpu at July, 32
          baselineConsumption: 32,
          baselineCapacity: 128,
        },
      ],
    });

    // The exact payload baseline-edit-form.tsx builds when an operator changes
    // memory 150 -> 160 and nothing else: `baselines` carries EVERY metric the
    // form renders (one dirty check for all of them), and `baselineDate` is
    // omitted because the date input was never touched.
    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: {
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 160, baselineCapacity: 1000 },
          { metricTypeKey: 'cpu_cores_195g', baselineConsumption: 32, baselineCapacity: 128 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    // Two rows, each corrected IN PLACE at its own period. A cluster-wide MAX
    // lands memory at July as a THIRD row — a memory measurement nobody took —
    // and leaves May behind still carrying the stale 150.
    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
      include: { metricType: { select: { key: true } } },
      orderBy: { capturedAt: 'asc' },
    });
    expect(
      rows.map((r) => [
        r.metricType.key,
        r.capturedAt.toISOString().slice(0, 10),
        r.baselineConsumption.toNumber(),
      ]),
    ).toEqual([
      ['memory_gb', '2026-05-01', 160],
      ['cpu_cores_195g', '2026-07-01', 32],
    ]);

    // ...and the cpu staleness that `deriveBaselineDate`'s MIN exists to surface
    // survives. A cluster-wide period clears it to July, and the form then resets
    // its date input from this field onto a month the operator never typed.
    expect(clusterResponseSchema.parse(res.json()).baselineDate).toBe('2026-05-01');
  });

  it('leaves a metric whose submitted values are unchanged at its own fresher period', async () => {
    // #181's rule — an omitted metric must be untouched — extended to an
    // UNCHANGED one, because baseline-edit-form.tsx makes "omitted" almost
    // unreachable: it submits every rendered metric the moment any one number is
    // dirty. A metric therefore counts as "named" merely by being present, and
    // presence is not intent.
    //
    // The shape is the ordinary one, not a contrived one. The snapshot job writes
    // memory_gb only, so memory runs ahead while a second metric lags; the form
    // pre-fills its date from ClusterResponse.baselineDate, which is MIN over the
    // newest row per metric — the LAGGING one. Correcting the lagging metric and
    // the date therefore arrives here as "memory is named, and its newest row is
    // after the target", which dragged the fresher August measurement backwards
    // onto a date chosen for a different metric entirely.
    await prisma.metricType.upsert({
      where: { key: 'cpu_cores_195h' },
      update: {},
      create: { key: 'cpu_cores_195h', displayName: 'CPU (test)', unit: 'cores' },
    });
    const cluster = await makeCluster(prisma, {
      name: uniqueName('unchanged-not-moved'),
      baselineDate: new Date(Date.UTC(2026, 7, 1)), // memory at August, 900
      baselineConsumption: 900,
      baselineCapacity: 1200,
      extraBaselines: [
        {
          metricKey: 'cpu_cores_195h',
          capturedAt: new Date(Date.UTC(2026, 0, 1)), // cpu at January, 32
          baselineConsumption: 32,
          baselineCapacity: 128,
        },
      ],
    });

    // What the form pre-fills into its date input: MIN, the stalest metric.
    const prefilled = clusterResponseSchema.parse(
      (await server.inject({ method: 'GET', url: `/api/clusters/${cluster.id}` })).json(),
    );
    expect(prefilled.baselineDate).toBe('2026-01-01');

    // The operator corrects the cpu number and the date. memory rides along
    // verbatim — the same 900/1200 the form pre-filled from the August row.
    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: {
        baselineDate: '2025-12-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 900, baselineCapacity: 1200 },
          { metricTypeKey: 'cpu_cores_195h', baselineConsumption: 40, baselineCapacity: 128 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
      include: { metricType: { select: { key: true } } },
      orderBy: [{ metricType: { key: 'asc' } }, { capturedAt: 'asc' }],
    });
    // cpu — the metric actually corrected — moved onto the submitted period and
    // took the submitted value. memory kept BOTH its period and its numbers, and
    // gained no backdated twin: the payload said nothing new about it.
    expect(
      rows.map((r) => [
        r.metricType.key,
        r.capturedAt.toISOString().slice(0, 10),
        r.baselineConsumption.toNumber(),
      ]),
    ).toEqual([
      ['cpu_cores_195h', '2025-12-01', 40],
      ['memory_gb', '2026-08-01', 900],
    ]);

    // The operator's date is still echoed, so the form does not reset it away —
    // the corrected metric landed on it.
    expect(clusterResponseSchema.parse(res.json()).baselineDate).toBe('2025-12-01');
  });

  it('does not land an unchanged metric’s values on a recorded period behind it', async () => {
    // What restricting the MOVE makes newly possible, pinned so it cannot come
    // back. Skipping the move alone also skips the occupancy check that used to
    // refuse this request, and the upsert then writes the unchanged metric at the
    // target anyway — landing August's numbers on February's recorded snapshot.
    // That is a destroyed measurement with a 200 OK, strictly worse than the
    // over-refusal it replaced. An unchanged metric that already holds a FRESHER
    // row carries no information about the target period, so it is not written
    // there at all.
    //
    // Reachable from the primary UI: memory is snapshotted monthly, cpu is not,
    // and the form pre-fills the date from the cpu period.
    await prisma.metricType.upsert({
      where: { key: 'cpu_cores_195i' },
      update: {},
      create: { key: 'cpu_cores_195i', displayName: 'CPU (test)', unit: 'cores' },
    });
    const cluster = await makeCluster(prisma, {
      name: uniqueName('unchanged-no-overwrite'),
      baselineDate: new Date(Date.UTC(2026, 0, 1)), // memory January, 100
      baselineConsumption: 100,
      baselineCapacity: 1000,
      extraBaselines: [
        {
          metricKey: 'memory_gb',
          capturedAt: new Date(Date.UTC(2026, 1, 1)), // memory February, 110
          baselineConsumption: 110,
          baselineCapacity: 1000,
        },
        {
          metricKey: 'memory_gb',
          capturedAt: new Date(Date.UTC(2026, 7, 1)), // memory August, 900
          baselineConsumption: 900,
          baselineCapacity: 1200,
        },
        {
          metricKey: 'cpu_cores_195i',
          capturedAt: new Date(Date.UTC(2026, 0, 1)), // cpu January, 32
          baselineConsumption: 32,
          baselineCapacity: 128,
        },
      ],
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: {
        baselineDate: '2026-02-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 900, baselineCapacity: 1200 },
          { metricTypeKey: 'cpu_cores_195i', baselineConsumption: 40, baselineCapacity: 128 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
      include: { metricType: { select: { key: true } } },
      orderBy: [{ metricType: { key: 'asc' } }, { capturedAt: 'asc' }],
    });
    expect(
      rows.map((r) => [
        r.metricType.key,
        r.capturedAt.toISOString().slice(0, 10),
        r.baselineConsumption.toNumber(),
      ]),
    ).toEqual([
      ['cpu_cores_195i', '2026-01-01', 32],
      // cpu is genuinely corrected and its newest row is OLDER than the target, so
      // this is an ordinary appended measurement, not a re-date.
      ['cpu_cores_195i', '2026-02-01', 40],
      ['memory_gb', '2026-01-01', 100],
      // The assertion this test exists for: still 110, not August's 900.
      ['memory_gb', '2026-02-01', 110],
      ['memory_gb', '2026-08-01', 900],
    ]);
  });

  it('does not flip an unchanged synced metric that sits on the submitted period', async () => {
    // The SECOND way MAJOR A can be reached, and the reason "restrict the move"
    // alone is not enough. Writing an unchanged metric at the target is a
    // same-period upsert onto its own vSphere row, and the upsert flips `source` to
    // manual — so `absorbed` (source-gated) stops absorbing a pre-anchor
    // capacityDelta the measurement already contains, capacity inflates, and
    // utilization falls with nothing measured. Treating unchanged as untouched
    // never issues that write.
    const memory = await prisma.metricType.findUniqueOrThrow({ where: { key: 'memory_gb' } });
    await prisma.metricType.upsert({
      where: { key: 'cpu_cores_195j' },
      update: {},
      create: { key: 'cpu_cores_195j', displayName: 'CPU (test)', unit: 'cores' },
    });
    const cpu = await prisma.metricType.findUniqueOrThrow({ where: { key: 'cpu_cores_195j' } });
    const cluster = await prisma.cluster.create({
      data: {
        tenantId: 'default',
        name: uniqueName('unchanged-coincident'),
        source: 'vsphere',
        baselineHistory: {
          create: [
            {
              tenantId: 'default',
              metricTypeId: memory.id,
              capturedAt: new Date(Date.UTC(2026, 5, 1)), // memory at June, vSphere
              source: 'vsphere',
              baselineConsumption: 1000,
              baselineCapacity: 0, // Q9a: synced hosts carry the capacity
            },
            {
              tenantId: 'default',
              metricTypeId: cpu.id,
              capturedAt: new Date(Date.UTC(2026, 0, 1)), // cpu at January, vSphere
              source: 'vsphere',
              baselineConsumption: 10,
              baselineCapacity: 0,
            },
          ],
        },
      },
    });
    await makeHost(prisma, {
      clusterId: cluster.id,
      name: uniqueName('unchanged-coincident-host'),
      commissionedAt: new Date(Date.UTC(2026, 0, 1)),
      initialCapacity: [{ effectiveFrom: new Date(Date.UTC(2026, 0, 1)), amount: 2000 }],
    });
    await makeEvent(prisma, {
      clusterId: cluster.id,
      title: uniqueName('pre-anchor-capacity'),
      effectiveDate: new Date(Date.UTC(2026, 2, 1)), // March: before June, absorbed
      consumptionDelta: null,
      capacityDelta: 500,
    });

    const before = clusterResponseSchema.parse(
      (await server.inject({ method: 'GET', url: `/api/clusters/${cluster.id}` })).json(),
    );
    const beforeMemory = before.metrics.find((m) => m.metricTypeKey === 'memory_gb');
    expect(beforeMemory?.utilization).toBe(0.5); // 1000 / 2000, March absorbed

    // Operator corrects cpu and moves the cluster date onto June — where memory,
    // unchanged, already sits. memory rides along verbatim.
    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: {
        baselineDate: '2026-06-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 1000, baselineCapacity: 0 },
          { metricTypeKey: 'cpu_cores_195j', baselineConsumption: 20, baselineCapacity: 0 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    // memory's row is untouched: still June, still vSphere, so March stays absorbed
    // and utilization holds at 0.5.
    const memoryRow = await prisma.clusterBaselineHistory.findFirstOrThrow({
      where: { clusterId: cluster.id, metricTypeId: memory.id },
      orderBy: { capturedAt: 'desc' },
    });
    expect(memoryRow.capturedAt.toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(memoryRow.source).toBe('vsphere');

    const after = clusterResponseSchema.parse(
      (await server.inject({ method: 'GET', url: `/api/clusters/${cluster.id}` })).json(),
    );
    const afterMemory = after.metrics.find((m) => m.metricTypeKey === 'memory_gb');
    expect(afterMemory?.currentCapacity).toBe(2000);
    expect(afterMemory?.utilization).toBe(0.5);
  });

  it('refuses a metric listed twice instead of silently dropping one of the values', async () => {
    // The create-side twin of this lives above. Here Postgres cannot be the
    // backstop: the two entries resolve to the SAME (cluster, metric, period)
    // upsert key, and sequential upserts inside one transaction never breach the
    // period index — the second simply overwrites the first. So without a
    // pre-write refusal the operator submits two numbers, gets 200 OK, and one of
    // them is gone with nothing to indicate which.
    const cluster = await makeCluster(prisma, {
      name: uniqueName('dup-metric-update'),
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 100,
      baselineCapacity: 1000,
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${cluster.id}`,
      payload: {
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
          { metricTypeKey: 'memory_gb', baselineConsumption: 200, baselineCapacity: 2000 },
        ],
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BASELINE_PERIOD_OCCUPIED');
    expect(body.error.message).toContain('memory_gb');

    // The refusal ran before the write, so the stored baseline is untouched —
    // neither submitted value was applied.
    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
    });
    expect(rows.map((r) => r.baselineConsumption.toNumber())).toEqual([100]);
  });
});
