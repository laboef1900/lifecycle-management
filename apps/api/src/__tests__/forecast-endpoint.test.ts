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
  const cluster = await makeCluster(prisma, {
    baselineConsumption: 3378,
    baselineCapacity: 7680,
  });
  clusterId = cluster.id;
});

afterAll(async () => {
  await server.close();
});

describe('GET /api/clusters/:id/forecast', () => {
  it('returns 24 months by default starting at the baseline date', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=memory_gb`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      fromMonth: string;
      toMonth: string;
      months: Array<{ month: string; consumption: number; capacity: number }>;
      effectiveThresholds: { warn: number; crit: number; source: string };
      procurement: { leadTimeWeeks: number; orderByDate: string | null; breachMonth: string | null };
    };
    expect(body.fromMonth).toBe('2026-05-01');
    expect(body.toMonth).toBe('2028-05-01');
    expect(body.months).toHaveLength(25);
    expect(body.months[0]).toMatchObject({ consumption: 3378, capacity: 7680 });
    expect(body.effectiveThresholds).toEqual({
      warn: 0.7,
      crit: 0.9,
      source: 'tenant',
    });
    // The seeded cluster's forecast never crosses warn within the default
    // window, so orderByDate/breachMonth are null; leadTimeWeeks falls back to
    // the tenant default (8).
    expect(body.procurement).toEqual({
      leadTimeWeeks: 8,
      orderByDate: null,
      breachMonth: null,
    });
  });

  it('honors from/to query parameters', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=memory_gb&from=2026-06&to=2026-08`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      months: Array<{ month: string }>;
    };
    expect(body.months.map((m) => m.month)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);
  });

  it('folds host capacity and application allocation into the time series', async () => {
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: {
        name: 'host-1',
        commissionedAt: '2026-07-01',
        capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-07-01', amount: 1024 }],
      },
    });
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/applications`,
      payload: {
        name: 'app-1',
        category: 'openshift',
        startedAt: '2026-08-01',
        allocations: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-08-01', amount: 200 }],
      },
    });
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/events`,
      payload: {
        metricTypeKey: 'memory_gb',
        effectiveDate: '2026-09-01',
        category: 'growth',
        title: 'Q3 growth',
        consumptionDelta: 100,
      },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=memory_gb&from=2026-06&to=2026-09`,
    });
    const body = response.json() as {
      months: Array<{ month: string; consumption: number; capacity: number }>;
      hosts: Array<{ name: string; contributions: Array<{ month: string; amount: number }> }>;
      applications: Array<{
        name: string;
        contributions: Array<{ month: string; amount: number }>;
      }>;
      events: Array<{ title: string }>;
    };

    const byMonth = Object.fromEntries(body.months.map((m) => [m.month, m]));
    expect(byMonth['2026-06-01']).toMatchObject({ consumption: 3378, capacity: 7680 });
    expect(byMonth['2026-07-01']).toMatchObject({ consumption: 3378, capacity: 8704 });
    expect(byMonth['2026-08-01']).toMatchObject({ consumption: 3578, capacity: 8704 });
    expect(byMonth['2026-09-01']).toMatchObject({ consumption: 3678, capacity: 8704 });
    expect(body.hosts).toHaveLength(1);
    expect(body.hosts[0]?.contributions).toEqual([
      { month: '2026-06-01', amount: 0 },
      { month: '2026-07-01', amount: 1024 },
      { month: '2026-08-01', amount: 1024 },
      { month: '2026-09-01', amount: 1024 },
    ]);
    expect(body.applications[0]?.contributions).toContainEqual({
      month: '2026-08-01',
      amount: 200,
    });
    expect(body.events.map((e) => e.title)).toEqual(['Q3 growth']);
  });

  it('returns 404 when the cluster does not exist', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/clusters/missing/forecast?metric=memory_gb',
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 422 when the metric is unknown', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=plutonium_kg`,
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe('UNKNOWN_METRIC');
  });

  it('exposes projectedDecommissionAt on each forecast host entry', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: {
        name: 'h-eol',
        commissionedAt: '2024-01-01',
        eolAt: '2027-06-01',
        capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2024-01-01', amount: 256 }],
      },
    });
    expect(createRes.statusCode).toBe(201);

    const forecast = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=memory_gb&from=2026-01&to=2028-01`,
    });
    expect(forecast.statusCode).toBe(200);
    const body = forecast.json() as {
      hosts: Array<{ name: string; projectedDecommissionAt: string | null }>;
    };
    const hEol = body.hosts.find((h) => h.name === 'h-eol');
    expect(hEol?.projectedDecommissionAt).toBe('2027-06-01');
  });

  it('returns 422 when the cluster does not track that metric', async () => {
    // The seed cluster only has memory_gb. Add a new metric type and ask for it.
    await prisma.metricType.upsert({
      where: { key: 'cpu_cores' },
      update: { displayName: 'CPU', unit: 'cores' },
      create: { key: 'cpu_cores', displayName: 'CPU', unit: 'cores' },
    });
    try {
      const response = await server.inject({
        method: 'GET',
        url: `/api/clusters/${clusterId}/forecast?metric=cpu_cores`,
      });
      expect(response.statusCode).toBe(422);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        'METRIC_NOT_TRACKED',
      );
    } finally {
      await prisma.metricType.deleteMany({ where: { key: 'cpu_cores' } });
    }
  });
});
