import { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { encrypt, loadKey } from '../crypto/secret-box.js';
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

/** A second, DIFFERENT 32-byte key — simulates CONFIG_ENCRYPTION_KEY rotation. */
const ROTATED_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');

const UNREACHABLE_ISSUER = 'http://127.0.0.1:1/oidc';
const DISTINCTIVE_SECRET = 'e2-distinctive-client-secret-do-not-leak';

/** Minimal payload satisfying authConfigUpdateSchema's required/defaulted fields. */
const localModePayload = {
  mode: 'local' as const,
  scopes: 'openid profile email',
  defaultRole: 'admin' as const,
  sessionTtlHours: 12,
  allowInsecure: false,
};

function extractCookieHeader(setCookie: string | string[] | undefined): string {
  return Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
}

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

  // The global `beforeEach` in setup.ts truncates `authConfig` (and `user`)
  // before every `it()`, but ONLY before individual tests — it does not run
  // before another file's `beforeAll`. `settings.test.ts` (which sorts right
  // after this file) boots ONE shared server in `beforeAll` and expects a
  // fresh disabled-mode config at that moment. The local-mode transition
  // guard tests below flip the singleton row to `mode: 'local'`, so this
  // file must restore it (and clear any local users it created) once all of
  // its own tests are done — mirrors the same pattern in
  // local-auth-routes.test.ts.
  afterAll(async () => {
    await prisma.authConfig.deleteMany({});
    await prisma.user.deleteMany({ where: { issuer: 'local' } });
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

    it('rejects enabling oidc when appBaseUrl is present but issuer/clientId/secret are missing: 422 INCOMPLETE_OIDC_CONFIG (#125)', async () => {
      const server = await buildDisabledServer();

      const response = await server.inject({
        method: 'PUT',
        url: '/api/settings/auth',
        payload: {
          mode: 'oidc',
          appBaseUrl: 'http://127.0.0.1:8080',
          allowInsecure: true,
        },
      });

      // A distinct code (not TEST_REQUIRED) so the UI can tell "fill in the
      // fields" apart from "the connection test failed".
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('INCOMPLETE_OIDC_CONFIG');

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

    it('fails with 422 ENCRYPTION_KEY_REQUIRED (not 500) when writing a client secret with no encryption key configured, and persists nothing', async () => {
      const server = await buildServer({
        env: makeTestEnv({ CONFIG_ENCRYPTION_KEY: undefined }),
        prisma,
      });
      created.push(server);
      expect(server.authConfig.current.mode).toBe('disabled');

      const response = await server.inject({
        method: 'PUT',
        url: '/api/settings/auth',
        payload: { mode: 'disabled', clientSecret: 'x' },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('ENCRYPTION_KEY_REQUIRED');

      // Nothing persisted: the boot-created singleton row (empty, no key to
      // encrypt with) still has no client secret stored.
      const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
      expect(row?.clientSecretEnc).toBeNull();

      const get = await server.inject({ method: 'GET', url: '/api/settings/auth' });
      expect(get.json()).toMatchObject({ mode: 'disabled', clientSecretSet: false });
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

    it('rejects an internal issuer in the open bootstrap window even with allowInsecure=true (#125 F1 SSRF)', async () => {
      // Production server => allowInternalIssuer is derived as false server-side,
      // so the caller-supplied allowInsecure flag cannot re-open the deny-list.
      const server = await buildDisabledServer({ NODE_ENV: 'production' });

      const response = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/test',
        payload: {
          issuerUrl: 'http://169.254.169.254/latest/meta-data/', // cloud-metadata probe
          clientId: 'attacker',
          clientSecret: DISTINCTIVE_SECRET,
          allowInsecure: true,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/private, loopback, or link-local/i);
      expect(body.error).not.toContain(DISTINCTIVE_SECRET);
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

  describe('CONFIG_ENCRYPTION_KEY rotation recovery via PUT /settings/auth', () => {
    it('re-entering the client secret after a key rotation succeeds (200, not 500) and leaves both secrets decryptable under the new key', async () => {
      // Seed an oidc row exactly as it would exist before a key rotation:
      // both secrets encrypted under the OLD key (K1).
      const oldKey = loadKey(CONFIG_ENCRYPTION_KEY);
      const staleSigningSecretEnc = encrypt('old-signing-secret', oldKey);
      await prisma.authConfig.create({
        data: {
          id: 'singleton',
          mode: 'oidc',
          issuerUrl,
          clientId: 'lcm-test',
          appBaseUrl: 'http://127.0.0.1:8080',
          allowInsecure: true,
          clientSecretEnc: encrypt('old-client-secret', oldKey),
          signingSecretEnc: staleSigningSecretEnc,
        },
      });

      // Boot with the ROTATED (new, K2) key — boot's fail-safe guard must
      // force mode=disabled without crashing, preserving the old ciphertext.
      const server = await buildServer({
        env: makeTestEnv({ CONFIG_ENCRYPTION_KEY: ROTATED_CONFIG_ENCRYPTION_KEY }),
        prisma,
      });
      created.push(server);
      expect(server.authConfig.current.mode).toBe('disabled');

      // The documented recovery: admin re-enters the client secret and saves.
      const response = await server.inject({
        method: 'PUT',
        url: '/api/settings/auth',
        payload: {
          mode: 'oidc',
          issuerUrl,
          clientId: 'lcm-test',
          clientSecret: 'freshly-re-entered-secret',
          appBaseUrl: 'http://127.0.0.1:8080',
          allowInsecure: true,
        },
      });

      // The core regression assertion: this must be 200, not a 500 caused by
      // reload() choking on the stale (old-key-encrypted) signing secret.
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.mode).toBe('oidc');
      expect(body.clientSecretSet).toBe(true);
      expect(body.signingSecretSet).toBe(true);
      expect(JSON.stringify(body)).not.toContain('freshly-re-entered-secret');

      // In-memory effective config (populated by reload() inside the PUT
      // handler) must be fully decryptable under the new key.
      expect(server.authConfig.current.mode).toBe('oidc');
      expect(server.authConfig.current.clientSecret).toBe('freshly-re-entered-secret');
      expect(server.authConfig.current.signingSecret).not.toBeNull();

      // A subsequent GET and an independent reload() must both succeed
      // (proves the row itself — not just in-memory state — is consistent).
      // Mode is oidc now, so the admin gate applies — authenticate as admin.
      const adminToken = await createUserSession('ADMIN');
      const get = await server.inject({
        method: 'GET',
        url: '/api/settings/auth',
        cookies: { [SESSION_COOKIE]: adminToken },
      });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toMatchObject({ clientSecretSet: true, signingSecretSet: true });

      await expect(server.authConfig.reload()).resolves.toBeUndefined();
      expect(server.authConfig.current.signingSecret).not.toBeNull();

      const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
      expect(row?.signingSecretEnc).not.toBeNull();
      // Regenerated, not the stale one left over from before the rotation.
      expect(row?.signingSecretEnc).not.toBe(staleSigningSecretEnc);
    });
  });

  describe('local account management', () => {
    it('creates and lists a local user, never leaking a password hash', async () => {
      const server = await buildDisabledServer();
      const create = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/local-users',
        payload: { username: 'newadmin', password: 'twelvecharsok!', role: 'ADMIN' },
      });
      expect(create.statusCode).toBe(201);
      const createdBody = create.json();
      expect(createdBody).toMatchObject({ username: 'newadmin', role: 'ADMIN', disabled: false });
      expect(JSON.stringify(createdBody)).not.toContain('passwordHash');
      expect(JSON.stringify(createdBody)).not.toMatch(/\$argon2/);

      const list = await server.inject({ method: 'GET', url: '/api/settings/auth/local-users' });
      expect(list.statusCode).toBe(200);
      expect(list.json().map((u: { username: string }) => u.username)).toContain('newadmin');
      expect(JSON.stringify(list.json())).not.toContain('passwordHash');
    });

    it('defaults role to ADMIN when omitted', async () => {
      const server = await buildDisabledServer();
      const create = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/local-users',
        payload: { username: 'defaultrole', password: 'twelvecharsok!' },
      });
      expect(create.statusCode).toBe(201);
      expect(create.json().role).toBe('ADMIN');
    });

    it('rejects an invalid create payload with 400 VALIDATION_ERROR', async () => {
      const server = await buildDisabledServer();
      const res = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/local-users',
        payload: { username: 'a b', password: 'short' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects creating a user with a taken username with 422 USERNAME_TAKEN', async () => {
      const server = await buildDisabledServer();
      await server.inject({
        method: 'POST',
        url: '/api/settings/auth/local-users',
        payload: { username: 'dupe', password: 'twelvecharsok!', role: 'ADMIN' },
      });

      const dupe = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/local-users',
        payload: { username: 'dupe', password: 'anotherpassword!', role: 'VIEWER' },
      });
      expect(dupe.statusCode).toBe(422);
      expect(dupe.json().error.code).toBe('USERNAME_TAKEN');
    });

    it('updates role and disabled via PATCH (204), reflected in a subsequent list', async () => {
      const server = await buildDisabledServer();
      const create = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/local-users',
        payload: { username: 'toedit', password: 'twelvecharsok!', role: 'VIEWER' },
      });
      const { id } = create.json();

      const patch = await server.inject({
        method: 'PATCH',
        url: `/api/settings/auth/local-users/${id}`,
        payload: { role: 'ADMIN', disabled: true },
      });
      expect(patch.statusCode).toBe(204);
      expect(patch.body).toBe('');

      const list = await server.inject({ method: 'GET', url: '/api/settings/auth/local-users' });
      const updated = list.json().find((u: { id: string }) => u.id === id) as {
        role: string;
        disabled: boolean;
      };
      expect(updated).toMatchObject({ role: 'ADMIN', disabled: true });
    });

    it('404s a PATCH for an unknown local-user id', async () => {
      const server = await buildDisabledServer();
      const res = await server.inject({
        method: 'PATCH',
        url: '/api/settings/auth/local-users/ckunknown0000000000000001',
        payload: { disabled: true },
      });
      expect(res.statusCode).toBe(404);
    });

    it('resets a password via POST reset-password (204)', async () => {
      const server = await buildDisabledServer();
      const create = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/local-users',
        payload: { username: 'resetme', password: 'twelvecharsok!', role: 'ADMIN' },
      });
      const { id } = create.json();

      const res = await server.inject({
        method: 'POST',
        url: `/api/settings/auth/local-users/${id}/reset-password`,
        payload: { newPassword: 'brandnewpassword!' },
      });
      expect(res.statusCode).toBe(204);
    });

    it('deletes a local user (204), no longer present in a subsequent list', async () => {
      const server = await buildDisabledServer();
      const create = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/local-users',
        payload: { username: 'deleteme', password: 'twelvecharsok!', role: 'VIEWER' },
      });
      const { id } = create.json();

      const del = await server.inject({
        method: 'DELETE',
        url: `/api/settings/auth/local-users/${id}`,
      });
      expect(del.statusCode).toBe(204);

      const list = await server.inject({ method: 'GET', url: '/api/settings/auth/local-users' });
      expect(list.json().map((u: { id: string }) => u.id)).not.toContain(id);
    });
  });

  describe('local mode transition guard', () => {
    it('refuses to switch to local mode with no enabled local admin (422 NO_LOCAL_ADMIN)', async () => {
      const server = await buildDisabledServer();
      const res = await server.inject({
        method: 'PUT',
        url: '/api/settings/auth',
        payload: localModePayload,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('NO_LOCAL_ADMIN');
      expect(server.authConfig.current.mode).toBe('disabled');
    });

    it('allows switching to local mode once an enabled local admin exists', async () => {
      const server = await buildDisabledServer();
      const create = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/local-users',
        payload: { username: 'firstadmin', password: 'twelvecharsok!', role: 'ADMIN' },
      });
      expect(create.statusCode).toBe(201);

      const res = await server.inject({
        method: 'PUT',
        url: '/api/settings/auth',
        payload: localModePayload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().mode).toBe('local');
      expect(server.authConfig.current.mode).toBe('local');
    });

    it('blocks disabling the last enabled local admin while mode is local (422 LAST_LOCAL_ADMIN)', async () => {
      const server = await buildDisabledServer();
      const create = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/local-users',
        payload: { username: 'onlyadmin', password: 'twelvecharsok!', role: 'ADMIN' },
      });
      const { id } = create.json();

      const enable = await server.inject({
        method: 'PUT',
        url: '/api/settings/auth',
        payload: localModePayload,
      });
      expect(enable.statusCode).toBe(200);

      const login = await server.inject({
        method: 'POST',
        url: '/api/auth/local/login',
        payload: { username: 'onlyadmin', password: 'twelvecharsok!' },
      });
      expect(login.statusCode).toBe(204);
      const cookieHeader = extractCookieHeader(login.headers['set-cookie']);

      const patch = await server.inject({
        method: 'PATCH',
        url: `/api/settings/auth/local-users/${id}`,
        headers: { cookie: cookieHeader },
        payload: { disabled: true },
      });
      expect(patch.statusCode).toBe(422);
      expect(patch.json().error.code).toBe('LAST_LOCAL_ADMIN');
    });

    it('blocks demoting the last enabled local admin to VIEWER while mode is local (422 LAST_LOCAL_ADMIN)', async () => {
      const server = await buildDisabledServer();
      const create = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/local-users',
        payload: { username: 'onlyadmin2', password: 'twelvecharsok!', role: 'ADMIN' },
      });
      const { id } = create.json();

      await server.inject({ method: 'PUT', url: '/api/settings/auth', payload: localModePayload });

      const login = await server.inject({
        method: 'POST',
        url: '/api/auth/local/login',
        payload: { username: 'onlyadmin2', password: 'twelvecharsok!' },
      });
      const cookieHeader = extractCookieHeader(login.headers['set-cookie']);

      const patch = await server.inject({
        method: 'PATCH',
        url: `/api/settings/auth/local-users/${id}`,
        headers: { cookie: cookieHeader },
        payload: { role: 'VIEWER' },
      });
      expect(patch.statusCode).toBe(422);
      expect(patch.json().error.code).toBe('LAST_LOCAL_ADMIN');
    });

    it('blocks deleting the last enabled local admin while mode is local (422 LAST_LOCAL_ADMIN)', async () => {
      const server = await buildDisabledServer();
      const create = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/local-users',
        payload: { username: 'onlyadmin3', password: 'twelvecharsok!', role: 'ADMIN' },
      });
      const { id } = create.json();

      await server.inject({ method: 'PUT', url: '/api/settings/auth', payload: localModePayload });

      const login = await server.inject({
        method: 'POST',
        url: '/api/auth/local/login',
        payload: { username: 'onlyadmin3', password: 'twelvecharsok!' },
      });
      const cookieHeader = extractCookieHeader(login.headers['set-cookie']);

      const del = await server.inject({
        method: 'DELETE',
        url: `/api/settings/auth/local-users/${id}`,
        headers: { cookie: cookieHeader },
      });
      expect(del.statusCode).toBe(422);
      expect(del.json().error.code).toBe('LAST_LOCAL_ADMIN');
    });

    it('allows disabling an admin once a second enabled local admin exists', async () => {
      const server = await buildDisabledServer();
      const first = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/local-users',
        payload: { username: 'twoadmins-a', password: 'twelvecharsok!', role: 'ADMIN' },
      });
      const second = await server.inject({
        method: 'POST',
        url: '/api/settings/auth/local-users',
        payload: { username: 'twoadmins-b', password: 'twelvecharsok!', role: 'ADMIN' },
      });
      const firstId = first.json().id as string;
      const secondId = second.json().id as string;

      await server.inject({ method: 'PUT', url: '/api/settings/auth', payload: localModePayload });

      const login = await server.inject({
        method: 'POST',
        url: '/api/auth/local/login',
        payload: { username: 'twoadmins-a', password: 'twelvecharsok!' },
      });
      const cookieHeader = extractCookieHeader(login.headers['set-cookie']);

      // Disabling the OTHER admin (secondId) while this one (firstId) stays
      // enabled must succeed — two enabled admins exist at the time of the check.
      const patch = await server.inject({
        method: 'PATCH',
        url: `/api/settings/auth/local-users/${secondId}`,
        headers: { cookie: cookieHeader },
        payload: { disabled: true },
      });
      expect(patch.statusCode).toBe(204);

      const list = await server.inject({
        method: 'GET',
        url: '/api/settings/auth/local-users',
        headers: { cookie: cookieHeader },
      });
      const rows = list.json() as Array<{ id: string; disabled: boolean }>;
      expect(rows.find((u) => u.id === secondId)?.disabled).toBe(true);
      expect(rows.find((u) => u.id === firstId)?.disabled).toBe(false);
    });
  });
});
