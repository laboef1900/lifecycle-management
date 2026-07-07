import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { LocalUserService } from '../services/local-users.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

/** A local-mode server: seed a local admin, then flip the singleton to local. */
async function localModeServer() {
  await new LocalUserService(prisma).create({
    username: 'admin',
    password: 'twelvecharsok!',
    role: 'ADMIN',
  });
  await prisma.authConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', mode: 'local' },
    update: { mode: 'local' },
  });
  return buildServer({ env: makeTestEnv(), prisma });
}

function extractCookieHeader(setCookie: string | string[] | undefined): string {
  return Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
}

describe('local auth routes', () => {
  const created: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (created.length) await created.pop()?.close();
  });

  // The global `beforeEach` in setup.ts truncates `authConfig` before every
  // `it()`, but ONLY before individual tests — it does not run before another
  // file's `beforeAll`. Several other suites (clusters.test.ts, hosts.test.ts)
  // build ONE shared server in `beforeAll` and expect a fresh disabled-mode
  // config at that moment. If this describe block's last test left the
  // singleton row flipped to `mode: 'local'`, whichever `beforeAll` runs next
  // in the shared single-worker process would boot with the stale mode and
  // 401 every request for its entire run. Restore the row so this file never
  // leaks auth state to a suite that doesn't touch auth config itself.
  afterAll(async () => {
    await prisma.authConfig.deleteMany({});
  });

  it('logs in with correct credentials and sets a session cookie', async () => {
    const server = await localModeServer();
    created.push(server);
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/local/login',
      payload: { username: 'admin', password: 'twelvecharsok!' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('rejects a wrong password generically', async () => {
    const server = await localModeServer();
    created.push(server);
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/local/login',
      payload: { username: 'admin', password: 'wrong-password!' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('reports authRequired + local login method at /auth/me', async () => {
    const server = await localModeServer();
    created.push(server);
    const res = await server.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.json()).toMatchObject({
      authRequired: true,
      loginMethods: { local: true, oidc: false },
    });
  });

  it('gates a protected mutation until logged in, then allows it', async () => {
    const server = await localModeServer();
    created.push(server);
    const denied = await server.inject({ method: 'GET', url: '/api/clusters' });
    expect(denied.statusCode).toBe(401);

    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/local/login',
      payload: { username: 'admin', password: 'twelvecharsok!' },
    });
    const cookie = login.headers['set-cookie'];
    const allowed = await server.inject({
      method: 'GET',
      url: '/api/clusters',
      headers: { cookie: extractCookieHeader(cookie) },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('changes password when authenticated, rejects a wrong current password, and revokes old sessions', async () => {
    const server = await localModeServer();
    created.push(server);

    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/local/login',
      payload: { username: 'admin', password: 'twelvecharsok!' },
    });
    const cookieHeader = extractCookieHeader(login.headers['set-cookie']);

    const unauthenticated = await server.inject({
      method: 'POST',
      url: '/api/auth/local/password',
      payload: { currentPassword: 'twelvecharsok!', newPassword: 'anothertwelve!' },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const wrongCurrent = await server.inject({
      method: 'POST',
      url: '/api/auth/local/password',
      headers: { cookie: cookieHeader },
      payload: { currentPassword: 'not-the-current-pw!', newPassword: 'anothertwelve!' },
    });
    expect(wrongCurrent.statusCode).toBe(422);
    expect(wrongCurrent.json()).toEqual({ error: 'invalid_credentials' });

    const changed = await server.inject({
      method: 'POST',
      url: '/api/auth/local/password',
      headers: { cookie: cookieHeader },
      payload: { currentPassword: 'twelvecharsok!', newPassword: 'anothertwelve!' },
    });
    expect(changed.statusCode).toBe(204);

    // Changing the password revokes existing sessions (LocalUserService.setPassword).
    const staleCookie = await server.inject({
      method: 'GET',
      url: '/api/clusters',
      headers: { cookie: cookieHeader },
    });
    expect(staleCookie.statusCode).toBe(401);

    // The new password logs in fine.
    const reLogin = await server.inject({
      method: 'POST',
      url: '/api/auth/local/login',
      payload: { username: 'admin', password: 'anothertwelve!' },
    });
    expect(reLogin.statusCode).toBe(204);
  });
});
