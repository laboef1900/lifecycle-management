import { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { SESSION_COOKIE } from '../plugins/auth.js';
import { buildServer } from '../server.js';
import { prisma } from './setup.js';
import { makeOidcTestEnv, makeTestEnv } from './test-helpers.js';

const LOGIN_STATE_COOKIE = 'lcm_login_state';

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
      env: makeOidcTestEnv({ OIDC_ISSUER_URL: issuerUrl, ...envOverrides }),
      prisma,
    });
    created.push(server);
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

  it('redirects to state_mismatch when the login-state cookie is missing', async () => {
    const server = await buildReadyServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/callback?code=whatever&state=whatever',
    });
    expect(response.headers.location).toBe('/login?error=state_mismatch');
  });

  it('redirects to idp_unavailable when discovery has not completed', async () => {
    const server = await buildServer({ env: makeOidcTestEnv(), prisma }); // unreachable issuer
    created.push(server);
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
