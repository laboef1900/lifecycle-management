import { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { SESSION_COOKIE } from '../plugins/auth.js';
import { buildServer } from '../server.js';
import { SessionService } from '../services/sessions.js';
import { prisma } from './setup.js';
import { makeOidcTestEnv, makeTestEnv } from './test-helpers.js';

/**
 * A valid 32-byte CONFIG_ENCRYPTION_KEY, local to this file — mirrors the
 * pattern in auth-routes.test.ts / auth-plugin.test.ts. Every server built
 * here needs a key so secrets can actually be encrypted/decrypted rather
 * than the auth-config plugin's missing-key fail-safe forcing mode=disabled.
 */
const CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

const UNREACHABLE_ISSUER = 'http://127.0.0.1:1/oidc';
const DISTINCTIVE_SECRET = 'e2-distinctive-client-secret-do-not-leak';

describe('/api/settings/auth', () => {
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
    while (created.length) {
      const server = created.pop();
      await server?.close();
    }
  });

  /** Fresh server, boots with mode=disabled (no OIDC env seeded). */
  async function buildDisabledServer(
    envOverrides: Parameters<typeof makeTestEnv>[0] = {},
  ): Promise<FastifyInstance> {
    const server = await buildServer({
      env: makeTestEnv({ CONFIG_ENCRYPTION_KEY, ...envOverrides }),
      prisma,
    });
    created.push(server);
    expect(server.authConfig.current.mode).toBe('disabled');
    return server;
  }

  /** Fresh server seeded into mode=oidc from env (unreachable issuer by default). */
  async function buildOidcServer(
    envOverrides: Parameters<typeof makeOidcTestEnv>[0] = {},
  ): Promise<FastifyInstance> {
    const server = await buildServer({
      env: makeOidcTestEnv({ CONFIG_ENCRYPTION_KEY, ...envOverrides }),
      prisma,
    });
    created.push(server);
    expect(server.authConfig.current.mode).toBe('oidc');
    return server;
  }

  async function createUserSession(role: 'ADMIN' | 'VIEWER'): Promise<string> {
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

  describe('GET /settings/auth', () => {
    it('returns the sanitized shape and never leaks a stored secret value', async () => {
      const server = await buildDisabledServer();

      const put = await server.inject({
        method: 'PUT',
        url: '/api/settings/auth',
        payload: { mode: 'disabled', clientSecret: DISTINCTIVE_SECRET },
      });
      expect(put.statusCode).toBe(200);

      const get = await server.inject({ method: 'GET', url: '/api/settings/auth' });
      expect(get.statusCode).toBe(200);
      const body = get.json();

      expect(body).toMatchObject({
        mode: 'disabled',
        clientSecretSet: true,
        discoveryStatus: 'disabled',
      });
      expect(JSON.stringify(body)).not.toContain(DISTINCTIVE_SECRET);
    });
  });

  describe('PUT /settings/auth', () => {
    it('enables oidc against a reachable issuer: persists, reloads, and reflects connected discoveryStatus', async () => {
      const server = await buildDisabledServer();

      const response = await server.inject({
        method: 'PUT',
        url: '/api/settings/auth',
        payload: {
          mode: 'oidc',
          issuerUrl,
          clientId: 'lcm-test',
          clientSecret: 'lcm-test-secret',
          appBaseUrl: 'http://127.0.0.1:8080',
          allowInsecure: true,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.mode).toBe('oidc');
      expect(body.discoveryStatus).toBe('connected');
      expect(body.clientSecretSet).toBe(true);
      expect(JSON.stringify(body)).not.toContain('lcm-test-secret');

      expect(server.authConfig.current.mode).toBe('oidc');
      expect(server.oidc.status).toBe('connected');
    });

    it('rejects enabling oidc against an unreachable issuer with 422 TEST_REQUIRED and persists nothing', async () => {
      const server = await buildDisabledServer();

      const response = await server.inject({
        method: 'PUT',
        url: '/api/settings/auth',
        payload: {
          mode: 'oidc',
          issuerUrl: UNREACHABLE_ISSUER,
          clientId: 'lcm-test',
          clientSecret: 'lcm-test-secret',
          appBaseUrl: 'http://127.0.0.1:8080',
          allowInsecure: true,
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('TEST_REQUIRED');

      // Nothing persisted: prior (disabled, empty) state is unchanged.
      const get = await server.inject({ method: 'GET', url: '/api/settings/auth' });
      expect(get.json()).toMatchObject({ mode: 'disabled', issuerUrl: null });
      expect(server.authConfig.current.mode).toBe('disabled');
    });

    it('rejects enabling oidc without an appBaseUrl (none stored, none supplied) with 422 APP_BASE_URL_REQUIRED', async () => {
      const server = await buildDisabledServer();

      const response = await server.inject({
        method: 'PUT',
        url: '/api/settings/auth',
        payload: {
          mode: 'oidc',
          issuerUrl: UNREACHABLE_ISSUER,
          clientId: 'lcm-test',
          clientSecret: 'lcm-test-secret',
          allowInsecure: true,
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('APP_BASE_URL_REQUIRED');

      const get = await server.inject({ method: 'GET', url: '/api/settings/auth' });
      expect(get.json().mode).toBe('disabled');
    });

    it('stores a client secret encrypted while switching to (or staying in) disabled mode', async () => {
      const server = await buildDisabledServer();

      const response = await server.inject({
        method: 'PUT',
        url: '/api/settings/auth',
        payload: { mode: 'disabled', clientSecret: 'x' },
      });
      expect(response.statusCode).toBe(200);

      const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
      expect(row?.clientSecretEnc).toBeTruthy();
      expect(row?.clientSecretEnc).not.toBe('x');

      const get = await server.inject({ method: 'GET', url: '/api/settings/auth' });
      const body = get.json();
      expect(body.clientSecretSet).toBe(true);
      expect(JSON.stringify(body)).not.toContain('"x"');
    });
  });

  describe('POST /settings/auth/test', () => {
    it('returns { ok:false } for an unreachable issuer and persists nothing', async () => {
      const server = await buildDisabledServer();

      const response = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/test',
        payload: {
          issuerUrl: UNREACHABLE_ISSUER,
          clientId: 'lcm-test',
          clientSecret: 'lcm-test-secret',
          allowInsecure: true,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');

      expect(server.authConfig.current.mode).toBe('disabled');
      expect(server.authConfig.current.issuerUrl).toBeNull();
    });

    it('returns { ok:true } for a reachable issuer', async () => {
      const server = await buildDisabledServer();

      const response = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/test',
        payload: {
          issuerUrl,
          clientId: 'lcm-test',
          clientSecret: 'lcm-test-secret',
          allowInsecure: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, error: null });
      expect(server.authConfig.current.mode).toBe('disabled');
    });
  });

  describe('authorization', () => {
    it('is open with no session when auth mode is disabled', async () => {
      const server = await buildDisabledServer();

      const response = await server.inject({ method: 'GET', url: '/api/settings/auth' });

      expect(response.statusCode).toBe(200);
    });

    it('rejects a VIEWER session with 403 and allows an ADMIN session with 200 when auth mode is oidc', async () => {
      const server = await buildOidcServer();
      const viewerToken = await createUserSession('VIEWER');
      const adminToken = await createUserSession('ADMIN');

      const asViewer = await server.inject({
        method: 'GET',
        url: '/api/settings/auth',
        cookies: { [SESSION_COOKIE]: viewerToken },
      });
      expect(asViewer.statusCode).toBe(403);
      expect(asViewer.json().error.code).toBe('FORBIDDEN');

      const asAdmin = await server.inject({
        method: 'GET',
        url: '/api/settings/auth',
        cookies: { [SESSION_COOKIE]: adminToken },
      });
      expect(asAdmin.statusCode).toBe(200);
    });
  });

  describe('POST /settings/auth/rotate-signing-secret', () => {
    it('rotates the signing secret, keeping signingSecretSet true', async () => {
      const server = await buildOidcServer();
      const adminToken = await createUserSession('ADMIN');
      const before = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
      expect(before?.signingSecretEnc).toBeTruthy();

      const response = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/rotate-signing-secret',
        cookies: { [SESSION_COOKIE]: adminToken },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ rotated: true });

      const after = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
      expect(after?.signingSecretEnc).toBeTruthy();
      expect(after?.signingSecretEnc).not.toBe(before?.signingSecretEnc);

      const get = await server.inject({
        method: 'GET',
        url: '/api/settings/auth',
        cookies: { [SESSION_COOKIE]: adminToken },
      });
      expect(get.json().signingSecretSet).toBe(true);
    });

    it('fails with 422 ENCRYPTION_KEY_REQUIRED when no encryption key is configured', async () => {
      const server = await buildServer({
        env: makeTestEnv({ CONFIG_ENCRYPTION_KEY: undefined }),
        prisma,
      });
      created.push(server);
      expect(server.authConfig.current.mode).toBe('disabled');

      const response = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/rotate-signing-secret',
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('ENCRYPTION_KEY_REQUIRED');
    });
  });
});
