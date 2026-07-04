import { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { SESSION_COOKIE } from '../plugins/auth.js';
import { buildServer } from '../server.js';
import { prisma } from './setup.js';
import { makeOidcTestEnv, makeTestEnv } from './test-helpers.js';

const LOGIN_STATE_COOKIE = 'lcm_login_state';

/**
 * A valid 32-byte CONFIG_ENCRYPTION_KEY, local to this file. The auth routes
 * now gate on `fastify.authConfig.current.mode` (DB-backed), not
 * `env.AUTH_MODE` directly — to actually land in oidc mode the auth-config
 * plugin needs a key so its boot-time seed from `makeOidcTestEnv`'s OIDC env
 * vars isn't forced back to disabled by the missing-key fail-safe guard (see
 * auth-config.ts). Same pattern as auth-plugin.test.ts's `oidcEnv()`;
 * deliberately not added to the shared `makeOidcTestEnv` in test-helpers.ts.
 */
const CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

describe('auth routes (oidc mode, mock IdP)', () => {
  let idp: OAuth2Server;
  let issuerUrl: string;
  const created: FastifyInstance[] = [];

  beforeAll(async () => {
    idp = new OAuth2Server();
    await idp.issuer.keys.generate('RS256');
    await idp.start(0, '127.0.0.1');
    issuerUrl = idp.issuer.url as string;
  });

  afterAll(async () => {
    await idp.stop();
  });

  afterEach(async () => {
    idp.service.removeAllListeners('beforeTokenSigning');
    while (created.length) {
      const server = created.pop();
      await server?.close();
    }
  });

  async function buildReadyServer(envOverrides: Parameters<typeof makeOidcTestEnv>[0] = {}) {
    const server = await buildServer({
      env: makeOidcTestEnv({
        OIDC_ISSUER_URL: issuerUrl,
        CONFIG_ENCRYPTION_KEY,
        ...envOverrides,
      }),
      prisma,
    });
    created.push(server);
    expect(server.authConfig.current.mode).toBe('oidc');
    await vi.waitFor(() => {
      expect(server.oidc.config).not.toBeNull();
    });
    return server;
  }

  function stubClaims(claims: Record<string, unknown>): void {
    idp.service.on('beforeTokenSigning', (token: { payload: Record<string, unknown> }) => {
      Object.assign(token.payload, claims);
    });
  }

  /** Drives login → IdP authorize → callback; returns the callback response. */
  async function completeLogin(server: FastifyInstance) {
    const login = await server.inject({ method: 'GET', url: '/api/auth/login' });
    expect(login.statusCode).toBe(302);
    const authorizeUrl = login.headers.location as string;
    expect(authorizeUrl.startsWith(issuerUrl)).toBe(true);
    const stateCookie = login.cookies.find((c) => c.name === LOGIN_STATE_COOKIE);
    expect(stateCookie).toBeDefined();

    const idpResponse = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(idpResponse.status).toBe(302);
    const callbackUrl = new URL(idpResponse.headers.get('location') as string);

    return server.inject({
      method: 'GET',
      url: `${callbackUrl.pathname}${callbackUrl.search}`,
      cookies: { [LOGIN_STATE_COOKIE]: (stateCookie as { value: string }).value },
    });
  }

  it('completes the full login flow: session cookie, user row, authenticated API access', async () => {
    stubClaims({ email: 'ada@example.com', name: 'Ada', groups: ['lcm-admins'] });
    const server = await buildReadyServer({
      OIDC_ROLE_CLAIM: 'groups',
      OIDC_ADMIN_VALUES: 'lcm-admins',
    });

    const callback = await completeLogin(server);
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/');
    const sessionCookie = callback.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });

    const user = await prisma.user.findFirst({ where: { email: 'ada@example.com' } });
    expect(user).toMatchObject({ role: 'ADMIN', displayName: 'Ada' });

    const me = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [SESSION_COOKIE]: (sessionCookie as { value: string }).value },
    });
    expect(me.json()).toEqual({
      authRequired: true,
      user: { id: user?.id, email: 'ada@example.com', displayName: 'Ada', role: 'ADMIN' },
    });

    const clusters = await server.inject({
      method: 'GET',
      url: '/api/clusters',
      cookies: { [SESSION_COOKIE]: (sessionCookie as { value: string }).value },
    });
    expect(clusters.statusCode).toBe(200);
  });

  it('rejects logins outside the email allowlist without creating a user', async () => {
    stubClaims({ email: 'intruder@evil.com' });
    const server = await buildReadyServer({ OIDC_ALLOWED_EMAIL_DOMAINS: 'example.com' });

    const callback = await completeLogin(server);
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/login?error=access_denied');
    expect(await prisma.user.count()).toBe(0);
  });

  it('rejects a tampered callback state that no longer matches the login-state cookie (login_failed)', async () => {
    // Security-critical: proves authorizationCodeGrant's state/nonce/PKCE
    // validation actually rejects a real IdP response once the callback's
    // `state` param has been tampered with after the cookie recorded the
    // original one. This exercises the real oauth4webapi state check, not a
    // stub — the mismatch throws synchronously inside authorizationCodeGrant
    // (before any token-exchange network call), which the route catches and
    // maps to `login_failed`.
    stubClaims({ email: 'ada@example.com' });
    const server = await buildReadyServer();

    const login = await server.inject({ method: 'GET', url: '/api/auth/login' });
    expect(login.statusCode).toBe(302);
    const authorizeUrl = login.headers.location as string;
    expect(authorizeUrl.startsWith(issuerUrl)).toBe(true);
    const stateCookie = login.cookies.find((c) => c.name === LOGIN_STATE_COOKIE);
    expect(stateCookie).toBeDefined();

    const idpResponse = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(idpResponse.status).toBe(302);
    const callbackUrl = new URL(idpResponse.headers.get('location') as string);
    expect(callbackUrl.searchParams.get('state')).toBeTruthy();
    // Tamper the state the IdP echoed back — the cookie still holds the
    // original, so authorizationCodeGrant must reject the mismatch.
    callbackUrl.searchParams.set('state', `${callbackUrl.searchParams.get('state')}-tampered`);

    const callback = await server.inject({
      method: 'GET',
      url: `${callbackUrl.pathname}${callbackUrl.search}`,
      cookies: { [LOGIN_STATE_COOKIE]: (stateCookie as { value: string }).value },
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/login?error=login_failed');
    expect(callback.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    expect(await prisma.user.count()).toBe(0);
  });

  it('redirects to idp_error and logs (but never echoes) the raw IdP error/description', async () => {
    const server = await buildReadyServer();
    const warnSpy = vi.spyOn(server.log, 'warn');

    const login = await server.inject({ method: 'GET', url: '/api/auth/login' });
    expect(login.statusCode).toBe(302);
    const stateCookie = login.cookies.find((c) => c.name === LOGIN_STATE_COOKIE);
    expect(stateCookie).toBeDefined();

    const callback = await server.inject({
      method: 'GET',
      url: '/api/auth/callback?error=access_denied&error_description=nope&state=whatever',
      cookies: { [LOGIN_STATE_COOKIE]: (stateCookie as { value: string }).value },
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/login?error=idp_error');
    expect(callback.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    expect(await prisma.user.count()).toBe(0);

    // The raw error/error_description must reach logs only, never the browser.
    expect(callback.headers.location).not.toContain('access_denied');
    expect(callback.headers.location).not.toContain('nope');
    expect(warnSpy).toHaveBeenCalledWith(
      { idpError: 'access_denied', idpErrorDescription: 'nope' },
      'IdP returned an error at callback',
    );
  });

  it('redirects to state_mismatch when the login-state cookie is missing', async () => {
    const server = await buildReadyServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/callback?code=whatever&state=whatever',
    });
    expect(response.headers.location).toBe('/login?error=state_mismatch');
  });

  it('redirects to idp_unavailable when discovery has not completed', async () => {
    // Needs CONFIG_ENCRYPTION_KEY so the seed actually lands in oidc mode (see
    // buildReadyServer's comment) — the default OIDC_ISSUER_URL is
    // unreachable, so discovery never completes and fastify.oidc.config stays
    // null, which is exactly what this test exercises.
    const server = await buildServer({ env: makeOidcTestEnv({ CONFIG_ENCRYPTION_KEY }), prisma });
    created.push(server);
    expect(server.authConfig.current.mode).toBe('oidc');
    const response = await server.inject({ method: 'GET', url: '/api/auth/login' });
    expect(response.headers.location).toBe('/login?error=idp_unavailable');
  });

  it('redirects to scheme_mismatch when APP_BASE_URL scheme differs from the request', async () => {
    const server = await buildReadyServer({ APP_BASE_URL: 'https://lcm.example.com' });
    const response = await server.inject({ method: 'GET', url: '/api/auth/login' });
    expect(response.headers.location).toBe('/login?error=scheme_mismatch');
  });

  it('logout destroys the session and clears the cookie', async () => {
    stubClaims({ email: 'ada@example.com' });
    const server = await buildReadyServer();
    const callback = await completeLogin(server);
    const token = (callback.cookies.find((c) => c.name === SESSION_COOKIE) as { value: string })
      .value;

    const logout = await server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(logout.statusCode).toBe(204);

    const me = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(me.json()).toEqual({ authRequired: true });
  });
});

describe('auth routes (disabled mode)', () => {
  it('reports authRequired=false and login redirects home', async () => {
    const server = await buildServer({ env: makeTestEnv(), prisma });
    try {
      const me = await server.inject({ method: 'GET', url: '/api/auth/me' });
      expect(me.json()).toEqual({ authRequired: false });
      const login = await server.inject({ method: 'GET', url: '/api/auth/login' });
      expect(login.statusCode).toBe(302);
      expect(login.headers.location).toBe('/');
    } finally {
      await server.close();
    }
  });
});
