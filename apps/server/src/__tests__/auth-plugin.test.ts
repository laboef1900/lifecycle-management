import { afterEach, describe, expect, it } from 'vitest';

import { ANONYMOUS_USER, SESSION_COOKIE, authStartupWarnings } from '../plugins/auth.js';
import { buildServer } from '../server.js';
import { SessionService } from '../services/sessions.js';
import { prisma } from './setup.js';
import { makeOidcTestEnv, makeTestEnv } from './test-helpers.js';

describe('auth plugin', () => {
  const created: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (created.length) {
      const server = created.pop();
      await server?.close();
    }
  });

  async function createSession(): Promise<string> {
    const user = await prisma.user.create({
      data: { issuer: 'https://idp.test', subject: 'sub-1', email: 'a@example.com', role: 'ADMIN' },
    });
    const { token } = await new SessionService(prisma).create(user.id, 12);
    return token;
  }

  it('attaches the anonymous principal when AUTH_MODE=disabled', async () => {
    const server = await buildServer({ env: makeTestEnv(), prisma });
    created.push(server);
    server.get('/api/whoami', async (request) => ({ user: request.user }));

    const response = await server.inject({ method: 'GET', url: '/api/whoami' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: ANONYMOUS_USER });
  });

  it('rejects unauthenticated /api requests with the 401 envelope in oidc mode', async () => {
    const server = await buildServer({ env: makeOidcTestEnv(), prisma });
    created.push(server);

    const response = await server.inject({ method: 'GET', url: '/api/clusters' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('leaves health endpoints and /api/auth/* unauthenticated in oidc mode', async () => {
    const server = await buildServer({ env: makeOidcTestEnv(), prisma });
    created.push(server);

    expect((await server.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    // /api/auth/me exists from Task 8; before that it 404s — either way, not 401.
    const me = await server.inject({ method: 'GET', url: '/api/auth/me' });
    expect(me.statusCode).not.toBe(401);
  });

  it('accepts a valid session cookie and attaches the user', async () => {
    const token = await createSession();
    const server = await buildServer({ env: makeOidcTestEnv(), prisma });
    created.push(server);
    server.get('/api/whoami', async (request) => ({ email: request.user?.email }));

    const response = await server.inject({
      method: 'GET',
      url: '/api/whoami',
      cookies: { [SESSION_COOKIE]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ email: 'a@example.com' });
  });

  it('rejects garbage session cookies', async () => {
    const server = await buildServer({ env: makeOidcTestEnv(), prisma });
    created.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/api/clusters',
      cookies: { [SESSION_COOKIE]: 'not-a-real-token' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('authStartupWarnings', () => {
  it('warns about disabled auth in production, wide-open oidc, and insecure issuers', () => {
    expect(authStartupWarnings(makeTestEnv({ NODE_ENV: 'production' }))).toHaveLength(1);
    expect(authStartupWarnings(makeTestEnv())).toHaveLength(0);
    // makeOidcTestEnv sets OIDC_ALLOW_INSECURE=true and no allowlist/role claim → 2 warnings.
    expect(authStartupWarnings(makeOidcTestEnv())).toHaveLength(2);
    expect(
      authStartupWarnings(
        makeOidcTestEnv({ OIDC_ROLE_CLAIM: 'groups', OIDC_ALLOW_INSECURE: false }),
      ),
    ).toHaveLength(0);
  });
});
