import { OAuth2Server } from 'oauth2-mock-server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoveryBackoffMs } from '../plugins/oidc.js';
import { buildServer } from '../server.js';
import { prisma } from './setup.js';
import { makeOidcTestEnv, makeTestEnv } from './test-helpers.js';

describe('oidc plugin', () => {
  const created: Array<{ close: () => Promise<void> }> = [];
  let idp: OAuth2Server | undefined;

  afterEach(async () => {
    while (created.length) {
      const server = created.pop();
      await server?.close();
    }
    await idp?.stop();
    idp = undefined;
  });

  it('decorates an inert state when AUTH_MODE=disabled', async () => {
    const server = await buildServer({ env: makeTestEnv(), prisma });
    created.push(server);
    expect(server.oidc.config).toBeNull();
  });

  it('discovers the issuer in the background and computes the redirect URI', async () => {
    idp = new OAuth2Server();
    await idp.issuer.keys.generate('RS256');
    await idp.start(0, '127.0.0.1');
    const issuerUrl = idp.issuer.url;
    expect(issuerUrl).toBeDefined();

    const server = await buildServer({
      env: makeOidcTestEnv({ OIDC_ISSUER_URL: issuerUrl }),
      prisma,
    });
    created.push(server);

    await vi.waitFor(() => {
      expect(server.oidc.config).not.toBeNull();
    });
    expect(server.oidc.redirectUri).toBe('http://127.0.0.1:8080/api/auth/callback');
  });

  it('stays not-ready and closes cleanly after a real failed discovery attempt', async () => {
    // Fastify's `logger: false` (the test config) resolves to the shared
    // `abstract-logging` singleton, so spying on it catches the plugin's
    // `fastify.log.error` call regardless of when discovery fails relative
    // to when we install the spy. Restore it immediately after use since the
    // singleton is shared across every test in this (isolate:false) worker.
    const server = await buildServer({ env: makeOidcTestEnv(), prisma });
    const errorSpy = vi.spyOn(server.log, 'error');

    try {
      // Proves a real discovery attempt actually ran and failed (and that the
      // catch/retry-scheduling branch executed) rather than asserting a
      // state that is trivially true immediately after buildServer().
      await vi.waitFor(
        () => {
          expect(errorSpy).toHaveBeenCalledWith(
            expect.objectContaining({ attempt: expect.any(Number) }),
            expect.stringContaining('OIDC discovery failed'),
          );
        },
        { timeout: 5000, interval: 50 },
      );
    } finally {
      errorSpy.mockRestore();
    }

    expect(server.oidc.config).toBeNull();
    // Closing must cancel the pending backoff timer without throwing or
    // hanging (an uncancelled timer would keep the process alive / cause an
    // open-handle warning in the test run).
    await expect(server.close()).resolves.toBeUndefined();
  });
});

describe('discoveryBackoffMs', () => {
  it('doubles per attempt starting at 2s', () => {
    expect(discoveryBackoffMs(1)).toBe(2_000);
    expect(discoveryBackoffMs(2)).toBe(4_000);
    expect(discoveryBackoffMs(5)).toBe(32_000);
    expect(discoveryBackoffMs(6)).toBe(60_000);
  });

  it('clamps at 60s for higher attempt counts', () => {
    expect(discoveryBackoffMs(7)).toBe(60_000);
    expect(discoveryBackoffMs(20)).toBe(60_000);
  });
});
