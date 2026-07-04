import { afterEach, describe, expect, it } from 'vitest';

import { ANONYMOUS_USER, SESSION_COOKIE, authStartupWarnings } from '../plugins/auth.js';
import { buildServer } from '../server.js';
import { SessionService } from '../services/sessions.js';
import { prisma } from './setup.js';
import { makeOidcTestEnv, makeTestEnv } from './test-helpers.js';

/**
 * A valid 32-byte CONFIG_ENCRYPTION_KEY, local to this file. The auth gate now
 * reads `fastify.authConfig.current.mode` (DB-backed), not `env.AUTH_MODE`
 * directly — to actually land in oidc mode the auth-config plugin needs a key
 * so its boot-time seed from `makeOidcTestEnv`'s OIDC env vars isn't forced
 * back to disabled by the missing-key fail-safe guard (see auth-config.ts).
 * Deliberately not added to the shared `makeOidcTestEnv` in test-helpers.ts —
 * that fixture is also used by auth-routes.test.ts (D4 territory), which
 * should be left exactly as-is here.
 */
const CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

/** `makeOidcTestEnv`, plus the key needed for the seeded row to land in oidc mode. */
function oidcEnv(overrides: Parameters<typeof makeOidcTestEnv>[0] = {}) {
  return makeOidcTestEnv({ CONFIG_ENCRYPTION_KEY, ...overrides });
}

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

  it('attaches the anonymous principal when authConfig.current.mode is disabled', async () => {
    const server = await buildServer({ env: makeTestEnv(), prisma });
    created.push(server);
    expect(server.authConfig.current.mode).toBe('disabled');
    server.get('/api/whoami', async (request) => ({ user: request.user }));

    const response = await server.inject({ method: 'GET', url: '/api/whoami' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: ANONYMOUS_USER });
  });

  it('gates on fastify.authConfig.current.mode rather than raw env.AUTH_MODE', async () => {
    // makeOidcTestEnv() sets env.AUTH_MODE='oidc' but supplies no
    // CONFIG_ENCRYPTION_KEY. The auth-config plugin's missing-key fail-safe
    // guard therefore forces the persisted (and in-memory) config to
    // mode=disabled despite env.AUTH_MODE. If the auth gate still read
    // env.AUTH_MODE directly, this request would 401; reading
    // fastify.authConfig.current.mode instead must attach the anonymous
    // principal.
    const server = await buildServer({ env: makeOidcTestEnv(), prisma });
    created.push(server);
    expect(server.authConfig.current.mode).toBe('disabled');
    server.get('/api/gate-check', async (request) => ({ user: request.user }));

    const response = await server.inject({ method: 'GET', url: '/api/gate-check' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: ANONYMOUS_USER });
  });

  it('rejects unauthenticated /api requests with the 401 envelope in oidc mode', async () => {
    const server = await buildServer({ env: oidcEnv(), prisma });
    created.push(server);
    expect(server.authConfig.current.mode).toBe('oidc');

    const response = await server.inject({ method: 'GET', url: '/api/clusters' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('leaves health endpoints and /api/auth/* unauthenticated in oidc mode', async () => {
    const server = await buildServer({ env: oidcEnv(), prisma });
    created.push(server);

    expect((await server.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    // /api/auth/me exists from Task 8; before that it 404s — either way, not 401.
    const me = await server.inject({ method: 'GET', url: '/api/auth/me' });
    expect(me.statusCode).not.toBe(401);
  });

  it('accepts a valid session cookie and attaches the user', async () => {
    const token = await createSession();
    const server = await buildServer({ env: oidcEnv(), prisma });
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
    const server = await buildServer({ env: oidcEnv(), prisma });
    created.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/api/clusters',
      cookies: { [SESSION_COOKIE]: 'not-a-real-token' },
    });

    expect(response.statusCode).toBe(401);
  });

  describe('percent-encoded / traversal bypass regression', () => {
    it('rejects a percent-encoded /api prefix with no cookie (router decodes, hook must match router view)', async () => {
      const server = await buildServer({ env: oidcEnv(), prisma });
      created.push(server);

      // %61 = 'a'; find-my-way decodes this to /api/clusters before routing,
      // but request.url stays raw. A hook keyed off request.url would miss this.
      const response = await server.inject({ method: 'GET', url: '/%61pi/clusters' });

      expect(response.statusCode).toBe(401);
    });

    it('rejects when a query string is crafted to look like /api/auth/', async () => {
      const server = await buildServer({ env: oidcEnv(), prisma });
      created.push(server);

      const response = await server.inject({
        method: 'GET',
        url: '/api/clusters?x=/api/auth/',
      });

      expect(response.statusCode).toBe(401);
    });

    it('does not leak the /api/auth/ exemption to a sibling prefix like /api/authz/', async () => {
      const server = await buildServer({ env: oidcEnv(), prisma });
      created.push(server);
      server.get('/api/authz/secret', async () => ({ ok: true }));

      // '/api/authz/secret' starts with the literal string '/api/auth' but not
      // '/api/auth/'; the exemption check requires the trailing slash, so this
      // must still be enforced. A naive `startsWith('/api/auth')` (no slash)
      // would wrongly exempt it and return 200 instead of 401.
      const response = await server.inject({ method: 'GET', url: '/api/authz/secret' });

      expect(response.statusCode).toBe(401);
    });
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
