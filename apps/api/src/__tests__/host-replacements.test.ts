import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';
import { makeCluster } from './factories.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

let server: FastifyInstance;
let clusterA: string;
let clusterB: string;

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  clusterA = (await makeCluster(prisma)).id;
  clusterB = (await makeCluster(prisma)).id;
});

async function makeHostIn(clusterId: string): Promise<string> {
  const res = await server.inject({
    method: 'POST',
    url: `/api/clusters/${clusterId}/hosts`,
    payload: {
      name: `h-${Math.random().toString(36).slice(2, 8)}`,
      commissionedAt: '2024-01-01',
      capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2024-01-01', amount: 256 }],
    },
  });
  return (res.json() as { id: string }).id;
}

describe('POST /api/host-replacements', () => {
  it('creates a replacement within the same cluster', async () => {
    const oldH = await makeHostIn(clusterA);
    const newH = await makeHostIn(clusterA);
    const res = await server.inject({
      method: 'POST',
      url: '/api/host-replacements',
      payload: { oldHostId: oldH, newHostId: newH, swappedAt: '2026-05-25', reason: 'EOL swap' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, string>;
    expect(body).toMatchObject({
      oldHostId: oldH,
      newHostId: newH,
      swappedAt: '2026-05-25',
      reason: 'EOL swap',
    });
  });

  it('returns 422 when hosts are in different clusters', async () => {
    const oldH = await makeHostIn(clusterA);
    const newH = await makeHostIn(clusterB);
    const res = await server.inject({
      method: 'POST',
      url: '/api/host-replacements',
      payload: { oldHostId: oldH, newHostId: newH, swappedAt: '2026-05-25' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 409 on duplicate (oldHostId, newHostId)', async () => {
    const oldH = await makeHostIn(clusterA);
    const newH = await makeHostIn(clusterA);
    const payload = { oldHostId: oldH, newHostId: newH, swappedAt: '2026-05-25' };
    await server.inject({ method: 'POST', url: '/api/host-replacements', payload });
    const res = await server.inject({ method: 'POST', url: '/api/host-replacements', payload });
    expect(res.statusCode).toBe(409);
  });
});

describe('DELETE /api/host-replacements/:id', () => {
  it('hard-deletes the row and returns 204', async () => {
    const oldH = await makeHostIn(clusterA);
    const newH = await makeHostIn(clusterA);
    const created = await server.inject({
      method: 'POST',
      url: '/api/host-replacements',
      payload: { oldHostId: oldH, newHostId: newH, swappedAt: '2026-05-25' },
    });
    const { id } = created.json() as { id: string };
    const res = await server.inject({ method: 'DELETE', url: `/api/host-replacements/${id}` });
    expect(res.statusCode).toBe(204);
  });
});
