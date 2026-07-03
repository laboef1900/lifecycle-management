import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../server.js';
import { makeFakePrisma, makeTestEnv } from './test-helpers.js';

describe('health routes', () => {
  const created: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (created.length) {
      const server = created.pop();
      await server?.close();
    }
  });

  it('/healthz returns 200 with status ok', async () => {
    const server = await buildServer({ env: makeTestEnv(), prisma: makeFakePrisma() });
    created.push(server);

    const response = await server.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('/readyz returns 200 when the database ping succeeds', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ ok: 1 }]);
    const server = await buildServer({
      env: makeTestEnv(),
      prisma: makeFakePrisma({ queryRaw }),
    });
    created.push(server);

    const response = await server.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it('/readyz returns 503 with uniform error shape when the database is unreachable', async () => {
    const queryRaw = vi.fn().mockRejectedValue(new Error('connection refused'));
    const server = await buildServer({
      env: makeTestEnv(),
      prisma: makeFakePrisma({ queryRaw }),
    });
    created.push(server);

    const response = await server.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: 'DEPENDENCY_UNHEALTHY',
        message: 'Database is unreachable',
      },
    });
  });

  it('/healthz carries the helmet nosniff header and no CORS header when CORS_ORIGIN is unset', async () => {
    const server = await buildServer({ env: makeTestEnv(), prisma: makeFakePrisma() });
    created.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'http://example.test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
