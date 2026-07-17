import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
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
  it('creating a cluster writes both the history row and the legacy row (dual-write)', async () => {
    const id = await createCluster(uniqueName('create'), '2026-05-01');

    const history = await prisma.clusterBaselineHistory.findMany({ where: { clusterId: id } });
    expect(history).toHaveLength(1);
    expect(history[0]?.source).toBe('manual');
    expect(history[0]?.capturedAt.toISOString().slice(0, 10)).toBe('2026-05-01');

    // The legacy table is still written so an image rollback finds its data.
    const legacy = await prisma.clusterMetricBaseline.findMany({ where: { clusterId: id } });
    expect(legacy).toHaveLength(1);
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

describe('baseline history — the backfill migrated existing data losslessly', () => {
  it('every legacy baseline has a matching history row anchored on the cluster baselineDate', async () => {
    // The migration guards this with a row-count assertion and aborts the boot if
    // it fails; this re-checks the invariant against whatever the suite has
    // created, so a future write path that forgets the dual-write is caught here
    // rather than in production.
    const orphans = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM cluster_metric_baselines b
      WHERE NOT EXISTS (
        SELECT 1 FROM cluster_baseline_history h
        WHERE h.cluster_id = b.cluster_id AND h.metric_type_id = b.metric_type_id
      )
    `;
    expect(Number(orphans[0]?.count ?? 0)).toBe(0);
  });
});
