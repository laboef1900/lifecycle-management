import { OAuth2Server } from 'oauth2-mock-server';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('stays not-ready (and closes cleanly) when the issuer is unreachable', async () => {
    const server = await buildServer({ env: makeOidcTestEnv(), prisma });
    created.push(server);
    expect(server.oidc.config).toBeNull();
  });
});
