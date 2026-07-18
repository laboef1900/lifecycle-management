import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ANONYMOUS_USER,
  SESSION_COOKIE,
  authStartupWarnings,
  requiresAdmin,
} from '../plugins/auth.js';
import type { AuthConfigState } from '../plugins/auth-config.js';
import type { FastifyBaseLogger } from 'fastify';

import { buildServer, logAuthStartupWarnings } from '../server.js';
import type { EffectiveAuthConfig } from '../services/auth-config.js';
import { SessionService } from '../services/sessions.js';
import { makeCluster } from './factories.js';
import { prisma } from './setup.js';
import { makeOidcTestEnv, makeTestEnv } from './test-helpers.js';

const validClusterPayload = (name: string) => ({
  name,
  baselineDate: '2026-01-01',
  baselines: [{ metricTypeKey: 'memory_gb', baselineConsumption: 1, baselineCapacity: 2 }],
});

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

  describe('role enforcement (#118)', () => {
    async function sessionForRole(role: 'ADMIN' | 'VIEWER'): Promise<string> {
      const user = await prisma.user.create({
        data: {
          issuer: 'https://idp.test',
          subject: `sub-${role}`,
          email: `${role.toLowerCase()}@example.com`,
          role,
        },
      });
      const { token } = await new SessionService(prisma).create(user.id, 12);
      return token;
    }

    it('returns 403 FORBIDDEN when a VIEWER attempts a mutating /api route', async () => {
      const token = await sessionForRole('VIEWER');
      const server = await buildServer({ env: oidcEnv(), prisma });
      created.push(server);

      const res = await server.inject({
        method: 'POST',
        url: '/api/clusters',
        cookies: { [SESSION_COOKIE]: token },
        payload: validClusterPayload('viewer-attempt'),
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it('allows a VIEWER to read (GET) an /api route', async () => {
      const token = await sessionForRole('VIEWER');
      const server = await buildServer({ env: oidcEnv(), prisma });
      created.push(server);

      const res = await server.inject({
        method: 'GET',
        url: '/api/clusters',
        cookies: { [SESSION_COOKIE]: token },
      });

      expect(res.statusCode).toBe(200);
    });

    it('exempts the read-only forecast scenario POST from the admin gate (VIEWER allowed)', async () => {
      const token = await sessionForRole('VIEWER');
      const { id: clusterId } = await makeCluster(prisma);
      const server = await buildServer({ env: oidcEnv(), prisma });
      created.push(server);

      const res = await server.inject({
        method: 'POST',
        url: `/api/clusters/${clusterId}/forecast/scenario?metric=memory_gb`,
        cookies: { [SESSION_COOKIE]: token },
        payload: { kind: 'lose_hosts', count: 1 },
      });

      expect(res.statusCode).not.toBe(403);
      expect(res.statusCode).toBe(200);
    });

    it('allows an ADMIN to perform a mutating /api route', async () => {
      const token = await sessionForRole('ADMIN');
      const server = await buildServer({ env: oidcEnv(), prisma });
      created.push(server);

      const res = await server.inject({
        method: 'POST',
        url: '/api/clusters',
        cookies: { [SESSION_COOKIE]: token },
        payload: validClusterPayload('admin-made'),
      });

      expect(res.statusCode).toBe(201);
    });

    it('does not gate mutations in disabled mode (anonymous principal is ADMIN)', async () => {
      const server = await buildServer({ env: makeTestEnv(), prisma });
      created.push(server);

      const res = await server.inject({
        method: 'POST',
        url: '/api/clusters',
        payload: validClusterPayload('anon-made'),
      });

      expect(res.statusCode).toBe(201);
    });
  });

  describe('break-glass gate proof (#222)', () => {
    it('opens /api under RECOVERY_DISABLE_AUTH and closes it again on the next boot without the flag', async () => {
      // Boot 1: break-glass. The stored oidc row must be left alone, so the
      // API is open only for THIS process.
      const open = await buildServer({
        env: oidcEnv({ RECOVERY_DISABLE_AUTH: true }),
        prisma,
      });
      expect(open.authConfig.current.mode).toBe('disabled');
      expect(open.authConfig.storedMode).toBe('oidc');
      const anonymous = await open.inject({ method: 'GET', url: '/api/clusters' });
      expect(anonymous.statusCode).toBe(200);
      await open.close();

      // Boot 2: flag cleared, same row. This is `operations.md`'s "clear the
      // flag and restart to resume normal operation", proven end-to-end.
      const closed = await buildServer({ env: oidcEnv(), prisma });
      created.push(closed);
      expect(closed.authConfig.current.mode).toBe('oidc');

      const gated = await closed.inject({ method: 'GET', url: '/api/clusters' });
      expect(gated.statusCode).toBe(401);
    });
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
  /** Mirrors the disabled `EffectiveAuthConfig` the auth-config plugin seeds by default. */
  function makeConfig(overrides: Partial<EffectiveAuthConfig> = {}): EffectiveAuthConfig {
    return {
      mode: 'disabled',
      issuerUrl: null,
      clientId: null,
      clientSecret: null,
      signingSecret: null,
      appBaseUrl: null,
      scopes: 'openid profile email',
      roleClaim: null,
      adminValues: null,
      defaultRole: 'admin',
      allowedEmailDomains: null,
      allowedEmails: null,
      sessionTtlHours: 12,
      allowInsecure: false,
      ...overrides,
    };
  }

  /** oidc mode with no allowlist/role claim and allowInsecure — mirrors makeOidcTestEnv's shape. */
  function makeOidcConfig(overrides: Partial<EffectiveAuthConfig> = {}): EffectiveAuthConfig {
    return makeConfig({
      mode: 'oidc',
      issuerUrl: 'http://127.0.0.1:1/oidc',
      clientId: 'lcm-test',
      clientSecret: 'lcm-test-secret',
      appBaseUrl: 'http://127.0.0.1:8080',
      allowInsecure: true,
      ...overrides,
    });
  }

  /**
   * Wraps an `EffectiveAuthConfig` in the auth-config state shape
   * `authStartupWarnings` now takes. Defaults to no divergence (stored ==
   * enforced, no break-glass) so the pre-existing cases below are unaffected.
   */
  function makeState(
    current: EffectiveAuthConfig,
    overrides: Partial<Pick<AuthConfigState, 'storedMode' | 'breakGlass'>> = {},
  ): Pick<AuthConfigState, 'current' | 'storedMode' | 'breakGlass'> {
    return { current, storedMode: current.mode, breakGlass: false, ...overrides };
  }

  it('warns about disabled auth in production, wide-open oidc, and insecure issuers', () => {
    expect(authStartupWarnings(makeState(makeConfig()), 'production')).toHaveLength(1);
    expect(authStartupWarnings(makeState(makeConfig()), 'test')).toHaveLength(0);
    // No allowlist/role claim and allowInsecure=true → 2 warnings.
    expect(authStartupWarnings(makeState(makeOidcConfig()), 'test')).toHaveLength(2);
    expect(
      authStartupWarnings(
        makeState(makeOidcConfig({ roleClaim: 'groups', allowInsecure: false })),
        'test',
      ),
    ).toHaveLength(0);
  });

  it('raises an error-level divergence alarm in every NODE_ENV', () => {
    const state = makeState(makeConfig({ mode: 'disabled' }), {
      storedMode: 'oidc',
      breakGlass: true,
    });

    for (const nodeEnv of ['test', 'development', 'production'] as const) {
      expect(authStartupWarnings(state, nodeEnv)).toContainEqual(
        expect.objectContaining({
          level: 'error',
          event: 'auth_config.open_despite_configuration',
        }),
      );
    }
  });

  it('names the cause-specific recovery: CONFIG_ENCRYPTION_KEY for a decrypt degrade, not break-glass', () => {
    // Every other assertion on this alarm sets breakGlass: true, so the
    // decrypt-cause half of the recovery copy was never executed. That branch
    // is the one an operator reads during exactly the incident #222 is about —
    // a divergence with break-glass OFF — and telling them to "clear
    // RECOVERY_DISABLE_AUTH" there is advice that cannot work, because the flag
    // they are being told to clear is not set.
    const decryptAlarm = authStartupWarnings(
      makeState(makeConfig({ mode: 'disabled' }), { storedMode: 'oidc', breakGlass: false }),
      'production',
    ).find((w) => w.event === 'auth_config.open_despite_configuration');

    expect(decryptAlarm).toBeDefined();
    expect(decryptAlarm?.level).toBe('error');
    expect(decryptAlarm?.message).toContain('CONFIG_ENCRYPTION_KEY');
    expect(decryptAlarm?.message).not.toContain('RECOVERY_DISABLE_AUTH');
    expect(decryptAlarm?.message).toContain("stored configuration is 'oidc'");

    // The break-glass branch must still name ITS own recovery — the two arms
    // are only meaningful if they actually differ.
    const breakGlassAlarm = authStartupWarnings(
      makeState(makeConfig({ mode: 'disabled' }), { storedMode: 'local', breakGlass: true }),
      'production',
    ).find((w) => w.event === 'auth_config.open_despite_configuration');

    expect(breakGlassAlarm?.message).toContain('RECOVERY_DISABLE_AUTH');
    expect(breakGlassAlarm?.message).not.toContain('CONFIG_ENCRYPTION_KEY');
    expect(breakGlassAlarm?.message).toContain("stored configuration is 'local'");
  });

  it('does not raise the divergence alarm when the enforced mode matches the stored mode', () => {
    const events = authStartupWarnings(makeState(makeConfig()), 'production').map((w) => w.event);
    expect(events).not.toContain('auth_config.open_despite_configuration');
  });

  it('emits the divergence alarm at error level, not warn', () => {
    // The alarm's severity only exists if the emitter honours `warning.level`.
    // `buildServer` runs with `logger: false` under NODE_ENV=test, so a revert
    // to a hardcoded `log.warn` is invisible unless the dispatch is asserted
    // directly — hence `logAuthStartupWarnings` being exported from server.ts.
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), fatal: vi.fn() };
    const warnings = authStartupWarnings(
      makeState(makeConfig({ mode: 'disabled' }), { storedMode: 'oidc', breakGlass: true }),
      'production',
    );

    logAuthStartupWarnings(log as unknown as FastifyBaseLogger, warnings);

    expect(log.error).toHaveBeenCalledWith(
      { event: 'auth_config.open_despite_configuration' },
      expect.stringContaining('DISABLED in memory'),
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      { event: 'auth_config.open_despite_configuration' },
      expect.anything(),
    );
    // The lower-severity findings still go out at their own level.
    expect(log.warn).toHaveBeenCalledWith(
      { event: 'auth_config.disabled_in_production' },
      expect.any(String),
    );
  });
});

describe('requiresAdmin', () => {
  it('requires admin for mutating /api routes', () => {
    expect(requiresAdmin('POST', '/api/clusters')).toBe(true);
    expect(requiresAdmin('PUT', '/api/clusters/:id')).toBe(true);
    expect(requiresAdmin('DELETE', '/api/hosts/:id')).toBe(true);
    expect(requiresAdmin('PATCH', '/api/items/:id')).toBe(true);
    expect(requiresAdmin('PUT', '/api/settings/tenant')).toBe(true);
    expect(requiresAdmin('POST', '/api/settings/auth/rotate-signing-secret')).toBe(true);
  });

  it('does not require admin for reads, the auth flow, or the read-only scenario query', () => {
    expect(requiresAdmin('GET', '/api/clusters')).toBe(false);
    expect(requiresAdmin('HEAD', '/api/clusters')).toBe(false);
    expect(requiresAdmin('POST', '/api/auth/logout')).toBe(false);
    expect(requiresAdmin('GET', '/api/auth/me')).toBe(false);
    expect(requiresAdmin('POST', '/api/clusters/:id/forecast/scenario')).toBe(false);
    // Non-/api routes (health) are never gated here.
    expect(requiresAdmin('POST', '/healthz')).toBe(false);
  });
});
