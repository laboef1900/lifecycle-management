import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_TENANT_ID } from '../plugins/tenant-context.js';
import { buildServer } from '../server.js';
import { makeFakePrisma, makeTestEnv } from './test-helpers.js';

describe('tenant-context plugin', () => {
  const created: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (created.length) {
      const server = created.pop();
      await server?.close();
    }
  });

  it('injects request.tenantId set to the default tenant on every request', async () => {
    const server = await buildServer({ env: makeTestEnv(), prisma: makeFakePrisma() });
    created.push(server);

    server.get('/whoami', async (request) => ({ tenantId: request.tenantId }));

    const response = await server.inject({ method: 'GET', url: '/whoami' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tenantId: DEFAULT_TENANT_ID });
  });
});
