import { afterEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../plugins/auth.js';
import { DEFAULT_TENANT_ID } from '../plugins/tenant-context.js';
import { buildServer } from '../server.js';
import { SessionService } from '../services/sessions.js';
import { makeFakePrisma, makeOidcTestEnv, makeTestEnv } from './test-helpers.js';
import { prisma } from './setup.js';

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

  it('resolves tenantId from the authenticated user in oidc mode', async () => {
    const user = await prisma.user.create({
      data: { issuer: 'https://idp.test', subject: 'sub-t', role: 'VIEWER' },
    });
    const { token } = await new SessionService(prisma).create(user.id, 12);
    const server = await buildServer({ env: makeOidcTestEnv(), prisma });
    created.push(server);
    server.get('/api/whoami', async (request) => ({ tenantId: request.tenantId }));

    const response = await server.inject({
      method: 'GET',
      url: '/api/whoami',
      cookies: { [SESSION_COOKIE]: token },
    });

    expect(response.json()).toEqual({ tenantId: 'default' });
  });
});
