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

const hostPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: `host-${Math.floor(Math.random() * 1e6)}`,
  commissionedAt: '2026-05-01',
  capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 512 }],
  ...overrides,
});

describe('POST /api/clusters/:clusterId/hosts', () => {
  it('creates a host with an initial capacity row and returns 201', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      id: string;
      clusterId: string;
      capacities: Array<{ effectiveFrom: string; amount: number; metricTypeKey: string }>;
    };
    expect(body.clusterId).toBe(clusterId);
    expect(body.capacities).toHaveLength(1);
    expect(body.capacities[0]).toMatchObject({
      effectiveFrom: '2026-05-01',
      amount: 512,
      metricTypeKey: 'memory_gb',
    });
  });

  it('returns 404 when the cluster does not exist', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/clusters/missing/hosts',
      payload: hostPayload(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 422 when capacity effectiveFrom is before commissionedAt', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        commissionedAt: '2026-06-01',
        capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 }],
      }),
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EFFECTIVE_BEFORE_COMMISSION',
    );
  });

  it('returns 422 on duplicate effectiveFrom for the same metric', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        capacities: [
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 },
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 512 },
        ],
      }),
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EFFECTIVE_NOT_MONOTONIC',
    );
  });

  it('accepts multiple capacities for the same metric in strictly increasing order', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        capacities: [
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 },
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-08-01', amount: 512 },
        ],
      }),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { capacities: Array<{ effectiveFrom: string }> };
    expect(body.capacities).toHaveLength(2);
  });
});

describe('GET /api/clusters/:clusterId/hosts', () => {
  it('returns hosts attached to the cluster', async () => {
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({ name: 'host-a' }),
    });
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({ name: 'host-b' }),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/hosts`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ name: string }>;
    expect(body.map((h) => h.name).sort()).toEqual(['host-a', 'host-b']);
  });

  it('returns 404 when the cluster does not exist', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/clusters/missing/hosts',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET / PUT / DELETE /api/hosts/:id', () => {
  it('GET returns the host', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({ name: 'detail-host' }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({ method: 'GET', url: `/api/hosts/${id}` });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { name: string }).name).toBe('detail-host');
  });

  it('GET returns 404 for unknown id', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/hosts/missing' });
    expect(response.statusCode).toBe(404);
  });

  it('PUT updates name and decommissionedAt without dropping capacity history', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        name: 'old-name',
        capacities: [
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 },
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-09-01', amount: 512 },
        ],
      }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'PUT',
      url: `/api/hosts/${id}`,
      payload: { name: 'new-name', decommissionedAt: '2027-01-01' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      name: string;
      decommissionedAt: string;
      capacities: unknown[];
    };
    expect(body.name).toBe('new-name');
    expect(body.decommissionedAt).toBe('2027-01-01');
    expect(body.capacities).toHaveLength(2);
  });

  it('PUT rejects commissionedAt after earliest capacity', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 }],
      }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'PUT',
      url: `/api/hosts/${id}`,
      payload: { commissionedAt: '2026-06-01' },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'INVALID_COMMISSIONED_AT',
    );
  });

  it('DELETE removes the host and cascades capacities', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload(),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({ method: 'DELETE', url: `/api/hosts/${id}` });
    expect(response.statusCode).toBe(204);

    const followup = await server.inject({ method: 'GET', url: `/api/hosts/${id}` });
    expect(followup.statusCode).toBe(404);
    const remaining = await prisma.hostMetricCapacity.count({ where: { hostId: id } });
    expect(remaining).toBe(0);
  });
});

describe('POST /api/hosts/:id/capacity', () => {
  it('appends a new capacity row and never updates the previous one', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 }],
      }),
    });
    const { id, capacities } = created.json() as {
      id: string;
      capacities: Array<{ id: string; amount: number; effectiveFrom: string }>;
    };
    const originalRowId = capacities[0]?.id;
    expect(originalRowId).toBeDefined();

    const append = await server.inject({
      method: 'POST',
      url: `/api/hosts/${id}/capacity`,
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-08-01', amount: 512 },
    });
    expect(append.statusCode).toBe(201);
    const body = append.json() as {
      capacities: Array<{ id: string; effectiveFrom: string; amount: number }>;
    };
    expect(body.capacities).toHaveLength(2);
    const original = body.capacities.find((c) => c.id === originalRowId);
    expect(original).toMatchObject({ effectiveFrom: '2026-05-01', amount: 256 });
  });

  it('returns 422 when effectiveFrom is not strictly after the latest row', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        capacities: [
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 },
          { metricTypeKey: 'memory_gb', effectiveFrom: '2026-08-01', amount: 512 },
        ],
      }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'POST',
      url: `/api/hosts/${id}/capacity`,
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-08-01', amount: 768 },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EFFECTIVE_NOT_MONOTONIC',
    );
  });

  it('returns 422 when effectiveFrom is before commissionedAt', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        commissionedAt: '2026-06-01',
        capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-06-01', amount: 256 }],
      }),
    });
    const { id } = created.json() as { id: string };

    const response = await server.inject({
      method: 'POST',
      url: `/api/hosts/${id}/capacity`,
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'EFFECTIVE_BEFORE_COMMISSION',
    );
  });

  it('returns 404 when the host does not exist', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/hosts/missing/capacity',
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 256 },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('asset attributes', () => {
  it('round-trips serial/vendor/model/warranty/eol on create', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({
        serialNumber: 'SN-001',
        vendor: 'Dell',
        model: 'R760',
        purchasedAt: '2024-01-15',
        warrantyEndsAt: '2027-01-15',
        eolAt: '2029-01-15',
      }),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      serialNumber: 'SN-001',
      vendor: 'Dell',
      model: 'R760',
      purchasedAt: '2024-01-15',
      warrantyEndsAt: '2027-01-15',
      eolAt: '2029-01-15',
      runPastEol: false,
      state: 'in_service',
    });
  });

  it('rejects updates that try to set state via PUT', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload(),
    });
    const { id } = created.json() as { id: string };
    const response = await server.inject({
      method: 'PUT',
      url: `/api/hosts/${id}`,
      payload: { state: 'degraded' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('round-trips asset attributes on PUT update', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload(),
    });
    const { id } = created.json() as { id: string };
    const update = await server.inject({
      method: 'PUT',
      url: `/api/hosts/${id}`,
      payload: { serialNumber: 'SN-999', vendor: 'HPE', eolAt: '2030-06-01', runPastEol: true },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({
      serialNumber: 'SN-999',
      vendor: 'HPE',
      eolAt: '2030-06-01',
      runPastEol: true,
    });
  });
});

describe('POST /api/hosts/:id/transitions', () => {
  it('transitions in_service -> degraded and returns 204', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload(),
    });
    const { id } = created.json() as { id: string };
    const res = await server.inject({
      method: 'POST',
      url: `/api/hosts/${id}/transitions`,
      payload: { toState: 'degraded', occurredAt: '2026-05-25', note: 'fan noise' },
    });
    expect(res.statusCode).toBe(204);

    const fetched = await server.inject({ method: 'GET', url: `/api/hosts/${id}` });
    expect((fetched.json() as { state: string }).state).toBe('degraded');
  });

  it('returns 422 on a disallowed edge', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload(),
    });
    const { id } = created.json() as { id: string };
    const res = await server.inject({
      method: 'POST',
      url: `/api/hosts/${id}/transitions`,
      payload: { toState: 'disposed', occurredAt: '2026-05-25' },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('GET /api/hosts/:id/lifecycle', () => {
  it('returns the lifecycle history after a transition', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload(),
    });
    const { id } = created.json() as { id: string };
    await server.inject({
      method: 'POST',
      url: `/api/hosts/${id}/transitions`,
      payload: { toState: 'degraded', occurredAt: '2026-05-25' },
    });
    const res = await server.inject({ method: 'GET', url: `/api/hosts/${id}/lifecycle` });
    expect(res.statusCode).toBe(200);
    const events = res.json() as Array<{ fromState: string | null; toState: string }>;
    expect(events.at(-1)).toMatchObject({ fromState: 'in_service', toState: 'degraded' });
  });
});

describe('projectedDecommissionAt on host response', () => {
  it('returns the EOL date when no replacement is scheduled and runPastEol=false', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({ eolAt: '2028-01-15' }),
    });
    expect(
      (created.json() as { projectedDecommissionAt: string | null }).projectedDecommissionAt,
    ).toBe('2028-01-15');
  });

  it('is null when runPastEol is true', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: hostPayload({ eolAt: '2028-01-15', runPastEol: true }),
    });
    expect(
      (created.json() as { projectedDecommissionAt: string | null }).projectedDecommissionAt,
    ).toBeNull();
  });
});
