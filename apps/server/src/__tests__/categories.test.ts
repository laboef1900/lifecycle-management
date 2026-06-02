import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { makeCluster } from './factories.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

const TENANT = 'default';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});

afterAll(async () => {
  await server.close();
});

async function seedCategory(name: string): Promise<string> {
  const row = await prisma.category.upsert({
    where: { tenantId_name: { tenantId: TENANT, name } },
    create: { tenantId: TENANT, name },
    update: {},
  });
  return row.id;
}

describe('GET /api/settings/categories', () => {
  it('lists categories sorted by name', async () => {
    await seedCategory('Zeta-cat');
    await seedCategory('Alpha-cat');

    const response = await server.inject({ method: 'GET', url: '/api/settings/categories' });
    expect(response.statusCode).toBe(200);
    const names = (response.json() as Array<{ id: string; name: string }>).map((c) => c.name);
    expect(names).toContain('Alpha-cat');
    expect(names).toContain('Zeta-cat');
    expect(names.indexOf('Alpha-cat')).toBeLessThan(names.indexOf('Zeta-cat'));
  });
});

describe('POST /api/settings/categories', () => {
  it('creates a category and returns 201', async () => {
    const name = `cat-${Math.floor(Math.random() * 1e9)}`;
    const response = await server.inject({
      method: 'POST',
      url: '/api/settings/categories',
      payload: { name },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; name: string };
    expect(body.name).toBe(name);
    expect(body.id).toBeDefined();
  });

  it('is idempotent — creating an existing name returns the same row', async () => {
    const name = `cat-${Math.floor(Math.random() * 1e9)}`;
    const first = await server.inject({
      method: 'POST',
      url: '/api/settings/categories',
      payload: { name },
    });
    const second = await server.inject({
      method: 'POST',
      url: '/api/settings/categories',
      payload: { name },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((first.json() as { id: string }).id).toBe((second.json() as { id: string }).id);
  });
});

describe('DELETE /api/settings/categories/:id', () => {
  it('deletes an unused category and returns 204', async () => {
    const id = await seedCategory(`unused-${Math.floor(Math.random() * 1e9)}`);

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/settings/categories/${id}`,
    });
    expect(response.statusCode).toBe(204);

    const gone = await prisma.category.findUnique({ where: { id } });
    expect(gone).toBeNull();
  });

  it('returns 409 with the usage count when the category is in use by an item', async () => {
    const name = `in-use-${Math.floor(Math.random() * 1e9)}`;
    const id = await seedCategory(name);
    const cluster = await makeCluster(prisma);

    await prisma.item.create({
      data: {
        tenantId: TENANT,
        clusterId: cluster.id,
        kind: 'event',
        name: 'uses-the-category',
        category: name,
        effectiveDate: new Date('2026-10-01T00:00:00.000Z'),
        metricTypeId: cluster.metricTypeId,
        consumptionDelta: null,
        capacityDelta: null,
      },
    });

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/settings/categories/${id}`,
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CATEGORY_IN_USE');
    expect(body.error.message).toContain('1 item');

    // The category survived the failed delete.
    const stillThere = await prisma.category.findUnique({ where: { id } });
    expect(stillThere).not.toBeNull();
  });

  it('returns 404 for an unknown id', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: '/api/settings/categories/clbogusclubogusclubogus0',
    });
    expect(response.statusCode).toBe(404);
  });
});
