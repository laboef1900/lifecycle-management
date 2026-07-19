import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { makeCluster } from './factories.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

/**
 * Append-only baseline history (#177, epic #172).
 *
 * These run against real Postgres via Testcontainers deliberately: the whole
 * point of several of them is that the DATABASE enforces a guarantee, not the
 * application. A mock would assert only that we believe our own code.
 */
let server: FastifyInstance;

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});

afterAll(async () => {
  await server.close();
});

let seq = 0;
const uniqueName = (s: string): string => `bh-${s}-${++seq}`;

async function createCluster(
  name: string,
  baselineDate: string,
  consumption = 100,
  capacity = 1000,
) {
  const res = await server.inject({
    method: 'POST',
    url: '/api/clusters',
    payload: {
      name,
      baselineDate,
      baselines: [
        {
          metricTypeKey: 'memory_gb',
          baselineConsumption: consumption,
          baselineCapacity: capacity,
        },
      ],
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

describe('baseline history — append semantics', () => {
  it('creating a cluster writes the history row', async () => {
    const id = await createCluster(uniqueName('create'), '2026-05-01');

    const history = await prisma.clusterBaselineHistory.findMany({ where: { clusterId: id } });
    expect(history).toHaveLength(1);
    expect(history[0]?.source).toBe('manual');
    expect(history[0]?.capturedAt.toISOString().slice(0, 10)).toBe('2026-05-01');
  });

  it('a baseline in a NEW month APPENDS rather than overwriting the previous one', async () => {
    const id = await createCluster(uniqueName('append'), '2026-05-01', 100, 1000);

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${id}`,
      payload: {
        baselineDate: '2026-06-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 150, baselineCapacity: 1000 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const history = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: id },
      orderBy: { capturedAt: 'asc' },
    });
    // The May measurement still exists — this is the whole point of the epic.
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.capturedAt.toISOString().slice(0, 10))).toEqual([
      '2026-05-01',
      '2026-06-01',
    ]);
    expect(history[0]?.baselineConsumption.toNumber()).toBe(100);
    expect(history[1]?.baselineConsumption.toNumber()).toBe(150);
  });

  it('re-entering the SAME month is an explicit correction, not a second truth', async () => {
    const id = await createCluster(uniqueName('correct'), '2026-05-01', 100, 1000);

    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${id}`,
      payload: {
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 111, baselineCapacity: 1000 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const history = await prisma.clusterBaselineHistory.findMany({ where: { clusterId: id } });
    expect(history).toHaveLength(1);
    expect(history[0]?.baselineConsumption.toNumber()).toBe(111);
  });

  it('a mid-month date snaps to the first of the month (the period anchor)', async () => {
    const id = await createCluster(uniqueName('snap'), '2026-05-17');

    const history = await prisma.clusterBaselineHistory.findMany({ where: { clusterId: id } });
    // Q6: manual and vSphere baselines must share one period key, or "the newest
    // baseline" would be decided by accident of day-of-month.
    expect(history[0]?.capturedAt.toISOString().slice(0, 10)).toBe('2026-05-01');
  });

  it('the DATABASE rejects two baselines for the same cluster/metric/period', async () => {
    const id = await createCluster(uniqueName('unique'), '2026-05-01');
    const existing = await prisma.clusterBaselineHistory.findFirstOrThrow({
      where: { clusterId: id },
    });

    // Not an application-level guard — Postgres itself must refuse. This is what
    // makes the monthly snapshot job (#178) idempotent under a restart it cannot
    // coordinate with.
    await expect(
      prisma.clusterBaselineHistory.create({
        data: {
          clusterId: id,
          tenantId: 'default',
          metricTypeId: existing.metricTypeId,
          capturedAt: existing.capturedAt,
          source: 'vsphere',
          baselineConsumption: 999,
          baselineCapacity: 999,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('baseline history — forecast anchoring', () => {
  it('the forecast anchors on the NEWEST baseline, not the first', async () => {
    const id = await createCluster(uniqueName('anchor'), '2026-05-01', 100, 1000);
    await server.inject({
      method: 'PUT',
      url: `/api/clusters/${id}`,
      payload: {
        baselineDate: '2026-07-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 250, baselineCapacity: 1000 },
        ],
      },
    });

    const res = await server.inject({
      method: 'GET',
      url: `/api/clusters/${id}/forecast?metric=memory_gb`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      fromMonth: string;
      months: Array<{ month: string; consumption: number }>;
      baselineHistory: Array<{ capturedAt: string; consumption: number; source: string }>;
    };

    // The window opens at the newest baseline, and the projection starts from its
    // value — anchoring on the first baseline would compound every modelling
    // error forever, which is what the monthly re-anchor exists to prevent.
    expect(body.fromMonth).toBe('2026-07-01');
    expect(body.months[0]?.consumption).toBe(250);

    // ...and the older measurement is still served, oldest first, for the chart.
    expect(body.baselineHistory).toHaveLength(2);
    expect(body.baselineHistory.map((h) => h.capturedAt)).toEqual(['2026-05-01', '2026-07-01']);
    expect(body.baselineHistory[0]?.consumption).toBe(100);
  });

  it('serves an unbroken history so a gap stays visibly absent rather than interpolated', async () => {
    const id = await createCluster(uniqueName('gap'), '2026-05-01', 100, 1000);
    for (const [date, consumption] of [
      ['2026-06-01', 120],
      // July deliberately missing — a snapshot that could not be taken.
      ['2026-08-01', 180],
    ] as const) {
      await server.inject({
        method: 'PUT',
        url: `/api/clusters/${id}`,
        payload: {
          baselineDate: date,
          baselines: [
            {
              metricTypeKey: 'memory_gb',
              baselineConsumption: consumption,
              baselineCapacity: 1000,
            },
          ],
        },
      });
    }

    const res = await server.inject({
      method: 'GET',
      url: `/api/clusters/${id}/forecast?metric=memory_gb`,
    });
    const body = res.json() as { baselineHistory: Array<{ capturedAt: string }> };

    // July is ABSENT, not zero. The contract requires renderers to break the line
    // here: joining June to August would fabricate a trend nobody measured.
    expect(body.baselineHistory.map((h) => h.capturedAt)).toEqual([
      '2026-05-01',
      '2026-06-01',
      '2026-08-01',
    ]);
  });
});

const CPU_KEY = 'cpu_cores_195';

/**
 * Three history rows across two metrics, shaped so that the three plausible
 * readings of `ClusterResponse.baselineDate` each give a DIFFERENT answer:
 *
 *   memory_gb  2026-03-01  (100)  the cluster's oldest row
 *   memory_gb  2026-08-01  (800)  memory's newest
 *   cpu        2026-05-01  ( 32)  cpu's newest — and the stalest metric
 *
 *   MIN over the newest row per metric ->  2026-05-01   (the contract)
 *   MAX over the newest row per metric ->  2026-08-01
 *   MIN over every row (naive, one stage) -> 2026-03-01
 *
 * Every other fixture in this suite holds exactly one row per metric, and under
 * that shape all three readings agree — which is why nothing else here can tell
 * a correct implementation from either wrong one.
 */
async function multiMetricCluster(): Promise<string> {
  await prisma.metricType.upsert({
    where: { key: CPU_KEY },
    update: {},
    create: { key: CPU_KEY, displayName: 'CPU (#195)', unit: 'cores' },
  });
  const cluster = await makeCluster(prisma, {
    name: uniqueName('min-derivation'),
    baselineDate: new Date(Date.UTC(2026, 2, 1)),
    baselineConsumption: 100,
    baselineCapacity: 1000,
    extraBaselines: [
      {
        metricKey: 'memory_gb',
        capturedAt: new Date(Date.UTC(2026, 7, 1)),
        baselineConsumption: 800,
        baselineCapacity: 1000,
      },
      {
        metricKey: CPU_KEY,
        capturedAt: new Date(Date.UTC(2026, 4, 1)),
        baselineConsumption: 32,
        baselineCapacity: 128,
      },
    ],
  });
  return cluster.id;
}

describe('baseline history — the derived cluster baselineDate', () => {
  it('reports the STALEST metric: MIN over the newest row per metric', async () => {
    const id = await multiMetricCluster();

    const res = await server.inject({ method: 'GET', url: `/api/clusters/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { baselineDate: string };

    // MIN, because the >90-day staleness flag has to react to the metric that
    // stopped being measured. MAX would render this cluster as freshly baselined
    // while cpu sat frozen since May — fresh-looking, unmeasured, and feeding the
    // numbers that buy hardware. The vSphere snapshot job writes memory_gb only,
    // so a multi-metric cluster drifting apart like this is the normal case, not
    // a contrived one.
    expect(body.baselineDate).toBe('2026-05-01');
    expect(body.baselineDate).not.toBe('2026-08-01'); // MAX
    expect(body.baselineDate).not.toBe('2026-03-01'); // MIN over every row
  });

  it('returns one entry per metric, each anchored on that metric’s newest row', async () => {
    const id = await multiMetricCluster();

    const res = await server.inject({ method: 'GET', url: `/api/clusters/${id}` });
    const body = res.json() as {
      metrics: Array<{ metricTypeKey: string; baselineConsumption: number }>;
    };

    // Three rows, two metrics: one entry PER METRIC, never one per period.
    expect(await prisma.clusterBaselineHistory.count({ where: { clusterId: id } })).toBe(3);
    expect(body.metrics).toHaveLength(2);

    // August's 800, not March's 100 — the guard against a first-write-wins or
    // ascending-order reduction, which would serve a five-month-old number under
    // a fresh-looking date.
    const memory = body.metrics.find((m) => m.metricTypeKey === 'memory_gb');
    expect(memory?.baselineConsumption).toBe(800);
  });

  it('orders metrics by metric key ascending', async () => {
    const id = await multiMetricCluster();

    const res = await server.inject({ method: 'GET', url: `/api/clusters/${id}` });
    const body = res.json() as { metrics: Array<{ metricTypeKey: string }> };

    // cluster-tile.tsx, cluster-panel.tsx and fleet-console.tsx all read
    // `metrics[0]` positionally. Insertion order would put memory first; key
    // order puts cpu first ('c' < 'm'), so this fails if the ordering is dropped.
    expect(body.metrics.map((m) => m.metricTypeKey)).toEqual([CPU_KEY, 'memory_gb']);
  });
});

describe('baseline history — history is the only source of ClusterResponse.metrics', () => {
  it('every metric served by the API is backed by a history row', async () => {
    // Replaces the #177 orphan invariant (every `cluster_metric_baselines` row
    // has a history row), which the contract migration makes vacuous by deleting
    // the table. Restated from the other end: nothing may reach a client that the
    // append-only history cannot account for.
    await createCluster(uniqueName('inv-a'), '2026-05-01');
    await createCluster(uniqueName('inv-b'), '2026-06-01');
    await multiMetricCluster();

    const res = await server.inject({ method: 'GET', url: '/api/clusters?limit=100' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ id: string; metrics: Array<{ metricTypeKey: string }> }>;
    };

    let checked = 0;
    for (const cluster of body.items) {
      for (const metric of cluster.metrics) {
        const row = await prisma.clusterBaselineHistory.findFirst({
          where: { clusterId: cluster.id, metricType: { key: metric.metricTypeKey } },
        });
        expect(row).not.toBeNull();
        checked += 1;
      }
    }
    // Without this the loop passes vacuously on an empty fleet.
    expect(checked).toBe(4);
  });
});
