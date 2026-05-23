import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { makeTestEnv } from './test-helpers.js';

const CLUSTER_PREFIX = '__test_events_cluster_';
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

const eventPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  metricTypeKey: 'memory_gb',
  effectiveDate: '2026-10-01',
  category: 'growth',
  title: 'Wachstum Q4',
  consumptionDelta: 750,
  ...overrides,
});

describe('POST /api/clusters/:clusterId/events', () => {
  it('creates a growth event with a consumption delta and returns 201', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/events`,
      payload: eventPayload(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      clusterId: string;
      category: string;
      consumptionDelta: number;
      capacityDelta: number | null;
      title: string;
    };
    expect(body.clusterId).toBe(clusterId);
    expect(body.category).toBe('growth');
    expect(body.consumptionDelta).toBe(750);
    expect(body.capacityDelta).toBeNull();
    expect(body.title).toBe('Wachstum Q4');
  });

  it('creates a hardware_change event with a capacity delta', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/events`,
      payload: eventPayload({
        category: 'hardware_change',
        title: 'Ausbau 2x HPE Server',
        consumptionDelta: null,
        capacityDelta: 4096,
      }),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { capacityDelta: number; consumptionDelta: number | null };
    expect(body.capacityDelta).toBe(4096);
    expect(body.consumptionDelta).toBeNull();
  });

  it("creates a 'note' event with both deltas null (annotation only)", async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/events`,
      payload: eventPayload({
        category: 'note',
        title: 'OpenShift go-live',
        consumptionDelta: null,
        capacityDelta: null,
      }),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { consumptionDelta: null; capacityDelta: null };
    expect(body.consumptionDelta).toBeNull();
    expect(body.capacityDelta).toBeNull();
  });

  it('rejects an event with both deltas null and a non-note category (400)', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/events`,
      payload: eventPayload({
        category: 'growth',
        consumptionDelta: null,
        capacityDelta: null,
      }),
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unknown category', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/events`,
      payload: eventPayload({ category: 'unknown_category' }),
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 when the metric key is unknown', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/events`,
      payload: eventPayload({ metricTypeKey: 'plutonium_kg' }),
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe('UNKNOWN_METRIC');
  });

  it('returns 404 when the cluster does not exist', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/clusters/missing/events',
      payload: eventPayload(),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/clusters/:clusterId/events', () => {
  it('returns events for the cluster ordered by effectiveDate ascending', async () => {
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/events`,
      payload: eventPayload({ effectiveDate: '2026-12-01', title: 'late' }),
    });
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/events`,
      payload: eventPayload({ effectiveDate: '2026-06-01', title: 'early' }),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/events`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ title: string }>;
    expect(body.map((e) => e.title)).toEqual(['early', 'late']);
  });

  it('returns 404 when the cluster does not exist', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/clusters/missing/events',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('PUT /api/events/:id', () => {
  it('updates title and effectiveDate', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/events`,
      payload: eventPayload({ title: 'before' }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'PUT',
      url: `/api/events/${id}`,
      payload: { title: 'after', effectiveDate: '2026-11-01' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { title: string; effectiveDate: string };
    expect(body.title).toBe('after');
    expect(body.effectiveDate).toBe('2026-11-01');
  });

  it('rejects nulling out both deltas when category is not note (merged check)', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/events`,
      payload: eventPayload({ category: 'growth', consumptionDelta: 100, capacityDelta: null }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'PUT',
      url: `/api/events/${id}`,
      payload: { consumptionDelta: null },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EVENT_REQUIRES_PAYLOAD',
    );
  });

  it('allows nulling both deltas if category is being changed to note in the same call', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/events`,
      payload: eventPayload({ category: 'growth', consumptionDelta: 100, capacityDelta: null }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'PUT',
      url: `/api/events/${id}`,
      payload: { category: 'note', consumptionDelta: null },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { category: string }).category).toBe('note');
  });

  it('returns 404 for unknown id', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: '/api/events/missing',
      payload: { title: 'whatever' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /api/events/:id', () => {
  it('removes the event and returns 204', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/events`,
      payload: eventPayload(),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({ method: 'DELETE', url: `/api/events/${id}` });
    expect(response.statusCode).toBe(204);

    const followup = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/events`,
    });
    expect((followup.json() as unknown[]).length).toBe(0);
  });

  it('returns 404 for unknown id', async () => {
    const response = await server.inject({ method: 'DELETE', url: '/api/events/missing' });
    expect(response.statusCode).toBe(404);
  });
});

describe('cluster delete cascade', () => {
  it('removes events when the parent cluster is deleted', async () => {
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/events`,
      payload: eventPayload(),
    });
    const deleteResp = await server.inject({ method: 'DELETE', url: `/api/clusters/${clusterId}` });
    expect(deleteResp.statusCode).toBe(204);

    const remaining = await prisma.event.count({ where: { clusterId } });
    expect(remaining).toBe(0);
  });
});
