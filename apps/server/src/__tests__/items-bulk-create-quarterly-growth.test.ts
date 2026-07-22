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

const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  category: 'Growth',
  metricTypeKey: 'memory_gb',
  entries: [
    { name: 'Wachstum Q1', effectiveDate: '2027-01-01', consumptionDelta: 100 },
    { name: 'Wachstum Q2', effectiveDate: '2027-04-01', consumptionDelta: 200 },
    { name: 'Wachstum Q3', effectiveDate: '2027-07-01', consumptionDelta: 300 },
    { name: 'Wachstum Q4', effectiveDate: '2027-10-01', consumptionDelta: 400 },
  ],
  ...overrides,
});

interface QuarterlyGrowthBody {
  created: number;
  items: Array<{
    id: string;
    kind: string;
    category: string;
    name: string;
    effectiveDate: string;
    consumptionDelta: number | null;
    capacityDelta: number | null;
    metricTypeKey: string | null;
  }>;
}

describe('POST /api/clusters/:clusterId/items/bulk-quarterly-growth', () => {
  it('creates one event item per quarter and returns 201', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items/bulk-quarterly-growth`,
      payload: payload(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as QuarterlyGrowthBody;
    expect(body.created).toBe(4);
    expect(body.items).toHaveLength(4);
    expect(body.items.map((item) => item.name)).toEqual([
      'Wachstum Q1',
      'Wachstum Q2',
      'Wachstum Q3',
      'Wachstum Q4',
    ]);
    for (const item of body.items) {
      expect(item.kind).toBe('event');
      expect(item.category).toBe('Growth');
      expect(item.metricTypeKey).toBe('memory_gb');
    }
    expect(body.items.map((item) => item.consumptionDelta)).toEqual([100, 200, 300, 400]);

    const stored = await prisma.item.findMany({ where: { clusterId } });
    expect(stored).toHaveLength(4);
  });

  it('accepts a partial year (fewer than 4 entries)', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items/bulk-quarterly-growth`,
      payload: payload({
        entries: [{ name: 'Wachstum Q4', effectiveDate: '2027-10-01', consumptionDelta: 400 }],
      }),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as QuarterlyGrowthBody;
    expect(body.created).toBe(1);
  });

  it('creates the category if it does not already exist', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items/bulk-quarterly-growth`,
      payload: payload({ category: 'brand-new-category' }),
    });

    expect(response.statusCode).toBe(201);
    const category = await prisma.category.findFirst({ where: { name: 'brand-new-category' } });
    expect(category).not.toBeNull();
  });

  it('returns 404 when the cluster does not exist', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/clusters/missing/items/bulk-quarterly-growth',
      payload: payload(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 422 when the metric key is unknown', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items/bulk-quarterly-growth`,
      payload: payload({ metricTypeKey: 'plutonium_kg' }),
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe('UNKNOWN_METRIC');
  });

  it('creates nothing when validation fails (all-or-nothing)', async () => {
    // Empty entries array violates the min(1) bound.
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items/bulk-quarterly-growth`,
      payload: payload({ entries: [] }),
    });
    expect(response.statusCode).toBe(400);

    const stored = await prisma.item.findMany({ where: { clusterId } });
    expect(stored).toHaveLength(0);
  });

  it('returns 400 when more than 4 entries are submitted', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items/bulk-quarterly-growth`,
      payload: payload({
        entries: [
          { name: 'Q1', effectiveDate: '2027-01-01' },
          { name: 'Q2', effectiveDate: '2027-04-01' },
          { name: 'Q3', effectiveDate: '2027-07-01' },
          { name: 'Q4', effectiveDate: '2027-10-01' },
          { name: 'Q5', effectiveDate: '2028-01-01' },
        ],
      }),
    });
    expect(response.statusCode).toBe(400);
  });
});
