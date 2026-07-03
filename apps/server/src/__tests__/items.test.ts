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
  kind: 'application',
  name: `app-${Math.floor(Math.random() * 1e6)}`,
  category: 'openshift',
  effectiveDate: '2026-06-01',
  allocations: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 144 }],
  ...overrides,
});

const eventPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'event',
  name: 'Wachstum Q4',
  category: 'growth',
  metricTypeKey: 'memory_gb',
  effectiveDate: '2026-10-01',
  consumptionDelta: 750,
  ...overrides,
});

describe('POST /api/clusters/:clusterId/items — application', () => {
  it('creates an application item with an initial allocation and returns 201', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: appPayload(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      clusterId: string;
      kind: string;
      category: string;
      allocations: Array<{ effectiveFrom: string; amount: number }>;
    };
    expect(body.clusterId).toBe(clusterId);
    expect(body.kind).toBe('application');
    expect(body.category).toBe('openshift');
    expect(body.allocations).toHaveLength(1);
    expect(body.allocations[0]).toMatchObject({ effectiveFrom: '2026-06-01', amount: 144 });
  });

  it('accepts an arbitrary free-form category (no enum constraint)', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: appPayload({ category: 'kafka-cluster' }),
    });
    expect(response.statusCode).toBe(201);
    expect((response.json() as { category: string }).category).toBe('kafka-cluster');
  });

  it('returns 404 when the cluster does not exist', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/clusters/missing/items',
      payload: appPayload(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 422 when allocation effectiveFrom is before effectiveDate', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: appPayload({
        effectiveDate: '2026-07-01',
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
      url: `/api/clusters/${clusterId}/items`,
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
      url: `/api/clusters/${clusterId}/items`,
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

describe('POST /api/clusters/:clusterId/items — event', () => {
  it('creates a growth event with a consumption delta and returns 201', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: eventPayload(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      clusterId: string;
      kind: string;
      category: string;
      consumptionDelta: number;
      capacityDelta: number | null;
      name: string;
      metricTypeKey: string | null;
      allocations: unknown[];
    };
    expect(body.clusterId).toBe(clusterId);
    expect(body.kind).toBe('event');
    expect(body.category).toBe('growth');
    expect(body.consumptionDelta).toBe(750);
    expect(body.capacityDelta).toBeNull();
    expect(body.name).toBe('Wachstum Q4');
    expect(body.metricTypeKey).toBe('memory_gb');
    expect(body.allocations).toEqual([]);
  });

  it('creates a hardware event with a capacity delta', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: eventPayload({
        category: 'hardware',
        name: 'Ausbau 2x HPE Server',
        consumptionDelta: null,
        capacityDelta: 4096,
      }),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { capacityDelta: number; consumptionDelta: number | null };
    expect(body.capacityDelta).toBe(4096);
    expect(body.consumptionDelta).toBeNull();
  });

  it('creates an event with both deltas null (annotation only) for ANY category', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: eventPayload({
        category: 'growth',
        name: 'OpenShift go-live',
        consumptionDelta: null,
        capacityDelta: null,
      }),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { consumptionDelta: null; capacityDelta: null };
    expect(body.consumptionDelta).toBeNull();
    expect(body.capacityDelta).toBeNull();
  });

  it('returns 422 when the metric key is unknown', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: eventPayload({ metricTypeKey: 'plutonium_kg' }),
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe('UNKNOWN_METRIC');
  });
});

describe('GET /api/clusters/:clusterId/items', () => {
  it('returns both kinds ordered by effectiveDate ascending', async () => {
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: eventPayload({ effectiveDate: '2026-12-01', name: 'late-event' }),
    });
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: appPayload({ name: 'early-app', effectiveDate: '2026-06-01' }),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/items`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{ name: string; kind: string }>;
      total: number;
    };
    expect(body.items.map((i) => i.name)).toEqual(['early-app', 'late-event']);
    expect(body.items.map((i) => i.kind)).toEqual(['application', 'event']);
    expect(body.total).toBe(2);
  });

  it('returns 404 when the cluster does not exist', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/clusters/missing/items',
    });
    expect(response.statusCode).toBe(404);
  });

  it('paginates results via limit/offset', async () => {
    for (let i = 0; i < 3; i += 1) {
      await server.inject({
        method: 'POST',
        url: `/api/clusters/${clusterId}/items`,
        payload: eventPayload({ name: `page-event-${i}`, effectiveDate: '2026-10-01' }),
      });
    }

    const firstPage = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/items?limit=2`,
    });
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
      url: `/api/clusters/${clusterId}/items?limit=2&offset=2`,
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json() as { items: unknown[]; total: number };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.total).toBe(3);
  });
});

describe('PATCH /api/items/:id', () => {
  it('updates name/category and preserves allocation history when ending an application', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
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
      method: 'PATCH',
      url: `/api/items/${id}`,
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

  it('updates name and effectiveDate on an event', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: eventPayload({ name: 'before' }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/items/${id}`,
      payload: { name: 'after', effectiveDate: '2026-11-01' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { name: string; effectiveDate: string };
    expect(body.name).toBe('after');
    expect(body.effectiveDate).toBe('2026-11-01');
  });

  it('rejects effectiveDate after the earliest allocation on an application', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: appPayload({
        allocations: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 144 }],
      }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/items/${id}`,
      payload: { effectiveDate: '2026-07-01' },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'INVALID_EFFECTIVE_DATE',
    );
  });

  it('rejects setting endedAt on an event (wrong kind)', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: eventPayload(),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/items/${id}`,
      payload: { endedAt: '2027-01-01' },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe('WRONG_KIND_FIELD');
  });

  it('rejects setting a delta on an application (wrong kind)', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: appPayload(),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/items/${id}`,
      payload: { consumptionDelta: 500 },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe('WRONG_KIND_FIELD');
  });

  it('returns 404 for unknown id', async () => {
    const response = await server.inject({
      method: 'PATCH',
      url: '/api/items/missing',
      payload: { name: 'whatever' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/items/:id/allocations', () => {
  it('appends a new allocation row and never updates the previous one', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
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
      url: `/api/items/${id}/allocations`,
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
      url: `/api/clusters/${clusterId}/items`,
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
      url: `/api/items/${id}/allocations`,
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-10-01', amount: 400 },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EFFECTIVE_NOT_MONOTONIC',
    );
  });

  it('returns 422 when effectiveFrom is before the item effectiveDate', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: appPayload({
        effectiveDate: '2026-06-01',
        allocations: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 144 }],
      }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'POST',
      url: `/api/items/${id}/allocations`,
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 200 },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EFFECTIVE_BEFORE_START',
    );
  });

  it('returns 422 when appending an allocation to an event item', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: eventPayload(),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'POST',
      url: `/api/items/${id}/allocations`,
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-11-01', amount: 200 },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe('NOT_AN_APPLICATION');
  });

  it('returns 404 when the item does not exist', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/items/missing/allocations',
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 144 },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /api/items/:id', () => {
  it('removes an application and cascades allocations', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: appPayload(),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({ method: 'DELETE', url: `/api/items/${id}` });
    expect(response.statusCode).toBe(204);

    const remaining = await prisma.itemAllocation.count({ where: { itemId: id } });
    expect(remaining).toBe(0);
    const stillThere = await prisma.item.findUnique({ where: { id } });
    expect(stillThere).toBeNull();
  });

  it('removes an event and returns 204', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: eventPayload(),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({ method: 'DELETE', url: `/api/items/${id}` });
    expect(response.statusCode).toBe(204);
  });

  it('returns 404 for unknown id', async () => {
    const response = await server.inject({ method: 'DELETE', url: '/api/items/missing' });
    expect(response.statusCode).toBe(404);
  });
});

describe('category auto-add on create', () => {
  it('adds a brand-new category to the managed list when an item is created', async () => {
    const brandNew = `auto-cat-${Math.floor(Math.random() * 1e9)}`;

    const before = await prisma.category.findFirst({
      where: { tenantId: 'default', name: brandNew },
    });
    expect(before).toBeNull();

    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: appPayload({ category: brandNew }),
    });
    expect(created.statusCode).toBe(201);

    const listed = await server.inject({ method: 'GET', url: '/api/settings/categories' });
    const names = (listed.json() as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain(brandNew);
  });
});

describe('cluster delete cascade', () => {
  it('removes items when the parent cluster is deleted', async () => {
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: eventPayload(),
    });
    const deleteResp = await server.inject({ method: 'DELETE', url: `/api/clusters/${clusterId}` });
    expect(deleteResp.statusCode).toBe(204);

    const remaining = await prisma.item.count({ where: { clusterId } });
    expect(remaining).toBe(0);
  });
});
