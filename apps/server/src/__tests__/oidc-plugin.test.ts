import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import * as http from 'node:http';
import { OAuth2Server } from 'oauth2-mock-server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import oidcPlugin, {
  discoveryBackoffMs,
  isPrivateAddress,
  issuerTargetsInternalAddress,
  sanitizeDiscoveryError,
  testDiscovery,
} from '../plugins/oidc.js';
import type { AuthConfigService, EffectiveAuthConfig } from '../services/auth-config.js';

/**
 * A minimal, hand-rolled OIDC issuer whose `/.well-known/openid-configuration`
 * response is held open until `respond()` is called. Used to deterministically
 * test that a fresh `reconfigure()` result cannot be clobbered by a slower,
 * superseded discovery attempt that started before it (Finding 2 / generation
 * guard).
 *
 * Deliberately real HTTP rather than mocking `openid-client`'s `discovery`
 * export: `vitest.config.ts` runs with `isolate: false` (module state is
 * shared across test FILES in the same worker — see the warning comment
 * there), and `vi.mock('openid-client', ...)` was found empirically to
 * become unreliable (silently stop intercepting calls) once other test files
 * that also import `openid-client` via `buildServer()` are part of the same
 * run. A real, controllable HTTP server sidesteps that entirely.
 *
 * `client.discovery()` only requires the metadata response to be a 200 with
 * `content-type: application/json` and a body whose `issuer` field matches
 * the requested origin — no other fields (e.g. jwks_uri) are needed for
 * discovery to resolve into a `Configuration`.
 */
function createControllableIssuer(): {
  originPromise: Promise<string>;
  /** Resolves once a discovery request has arrived and is being held open. */
  requested: Promise<void>;
  respond: (status: number, body?: Record<string, unknown>) => void;
  close: () => Promise<void>;
} {
  let resolveRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    resolveRequested = resolve;
  });
  let heldRes: http.ServerResponse | undefined;
  let origin = '';

  const server = http.createServer((_req, res) => {
    heldRes = res;
    resolveRequested();
  });

  const originPromise = new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      origin = `http://127.0.0.1:${port}`;
      resolve(origin);
    });
  });

  return {
    originPromise,
    requested,
    respond: (status, body) => {
      if (!heldRes) {
        throw new Error('createControllableIssuer: no request is pending to respond to');
      }
      heldRes.writeHead(status, { 'content-type': 'application/json' });
      heldRes.end(JSON.stringify(body ?? { issuer: origin }));
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function makeAuthConfig(overrides: Partial<EffectiveAuthConfig> = {}): EffectiveAuthConfig {
  return {
    mode: 'disabled',
    issuerUrl: null,
    clientId: null,
    clientSecret: null,
    signingSecret: null,
    appBaseUrl: 'http://127.0.0.1:8080',
    scopes: 'openid profile email',
    roleClaim: null,
    adminValues: null,
    defaultRole: 'admin',
    allowedEmailDomains: null,
    allowedEmails: null,
    sessionTtlHours: 12,
    allowInsecure: true,
    ...overrides,
  };
}

/**
 * Deliberately points at an unreachable issuer (port 1, connection refused)
 * so discovery fails fast without network flakiness — mirrors the pre-D2
 * `makeOidcTestEnv` default.
 */
function makeOidcConfig(overrides: Partial<EffectiveAuthConfig> = {}): EffectiveAuthConfig {
  return makeAuthConfig({
    mode: 'oidc',
    issuerUrl: 'http://127.0.0.1:1/oidc',
    clientId: 'lcm-test',
    clientSecret: 'lcm-test-secret',
    ...overrides,
  });
}

/**
 * Stands in for the real Task-C5 `auth-config` plugin: decorates
 * `fastify.authConfig` with a plain, mutable holder so tests can flip
 * `.current` directly and call `oidc.reconfigure()`, without touching
 * Prisma/encryption. Registered under the same plugin `name` the real
 * plugin uses so `oidc`'s `fp` `dependencies: ['auth-config']` is satisfied.
 */
function fakeAuthConfigPlugin(initial: EffectiveAuthConfig) {
  return fp(
    async (fastify) => {
      fastify.decorate('authConfig', {
        current: initial,
        service: {} as unknown as AuthConfigService,
        reload: async () => {},
      });
    },
    { name: 'auth-config' },
  );
}

async function buildTestServer(initial: EffectiveAuthConfig): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  await server.register(fakeAuthConfigPlugin(initial));
  await server.register(oidcPlugin);
  return server;
}

describe('oidc plugin', () => {
  const created: FastifyInstance[] = [];
  let idp: OAuth2Server | undefined;

  afterEach(async () => {
    while (created.length) {
      const server = created.pop();
      await server?.close();
    }
    await idp?.stop();
    idp = undefined;
  });

  it('decorates an inert, disabled state and never attempts discovery when mode is disabled', async () => {
    const server = await buildTestServer(makeAuthConfig({ mode: 'disabled' }));
    created.push(server);
    const errorSpy = vi.spyOn(server.log, 'error');
    const infoSpy = vi.spyOn(server.log, 'info');

    expect(server.oidc.status).toBe('disabled');
    expect(server.oidc.config).toBeNull();
    expect(server.oidc.lastError).toBeNull();

    // Give any wrongly-scheduled async discovery a chance to run before
    // asserting the negative (no discovery attempted).
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(server.oidc.status).toBe('disabled');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('discovers the issuer in the background and computes the redirect URI', async () => {
    idp = new OAuth2Server();
    await idp.issuer.keys.generate('RS256');
    await idp.start(0, '127.0.0.1');
    const issuerUrl = idp.issuer.url;
    expect(issuerUrl).toBeDefined();

    const server = await buildTestServer(
      makeOidcConfig({ issuerUrl: issuerUrl as string, appBaseUrl: 'http://127.0.0.1:8080' }),
    );
    created.push(server);

    await vi.waitFor(() => {
      expect(server.oidc.status).toBe('connected');
    });
    expect(server.oidc.config).not.toBeNull();
    expect(server.oidc.lastError).toBeNull();
    expect(server.oidc.redirectUri).toBe('http://127.0.0.1:8080/api/auth/callback');
  });

  it('stays unavailable and closes cleanly after a real failed discovery attempt', async () => {
    const server = await buildTestServer(makeOidcConfig());
    created.push(server);
    // Fastify's `logger: false` (the test config) resolves to the shared
    // `abstract-logging` singleton, so spying on it catches the plugin's
    // `fastify.log.error` call regardless of when discovery fails relative
    // to when we install the spy. Restore it immediately after use since the
    // singleton is shared across every test in this (isolate:false) worker.
    const errorSpy = vi.spyOn(server.log, 'error');

    try {
      // Proves a real discovery attempt actually ran and failed (and that the
      // catch/retry-scheduling branch executed) rather than asserting a
      // state that is trivially true immediately after buildTestServer().
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

    expect(server.oidc.status).toBe('unavailable');
    expect(server.oidc.config).toBeNull();
    expect(server.oidc.lastError).toBeTruthy();
    expect(server.oidc.lastError).not.toContain('lcm-test-secret');
    // Closing must cancel the pending backoff timer without throwing or
    // hanging (an uncancelled timer would keep the process alive / cause an
    // open-handle warning in the test run).
    await expect(server.close()).resolves.toBeUndefined();
  });

  it('reconfigure() flips status to unavailable and recomputes redirectUri when the config changes to an unreachable oidc issuer', async () => {
    const server = await buildTestServer(makeAuthConfig({ mode: 'disabled' }));
    created.push(server);
    expect(server.oidc.status).toBe('disabled');

    server.authConfig.current = makeOidcConfig({ appBaseUrl: 'http://127.0.0.1:9090' });
    await server.oidc.reconfigure();

    expect(server.oidc.status).toBe('unavailable');
    expect(server.oidc.config).toBeNull();
    expect(server.oidc.lastError).toBeTruthy();
    expect(server.oidc.lastError).not.toContain('lcm-test-secret');
    expect(server.oidc.redirectUri).toBe('http://127.0.0.1:9090/api/auth/callback');
  });

  it('reconfigure() switches back to disabled and clears config/lastError when mode flips away from oidc', async () => {
    const server = await buildTestServer(makeOidcConfig());
    created.push(server);
    // Let the initial (failing) discovery attempt land so lastError is
    // populated first, proving reconfigure() actually clears prior state
    // rather than it trivially starting out null.
    await vi.waitFor(() => {
      expect(server.oidc.status).toBe('unavailable');
    });
    expect(server.oidc.lastError).toBeTruthy();

    server.authConfig.current = makeAuthConfig({ mode: 'disabled' });
    await server.oidc.reconfigure();

    expect(server.oidc.status).toBe('disabled');
    expect(server.oidc.config).toBeNull();
    expect(server.oidc.lastError).toBeNull();
  });

  it('reconfigure() drives disabled -> connected when switching to a reachable oidc issuer (not just at boot)', async () => {
    idp = new OAuth2Server();
    await idp.issuer.keys.generate('RS256');
    await idp.start(0, '127.0.0.1');
    const issuerUrl = idp.issuer.url as string;

    const server = await buildTestServer(makeAuthConfig({ mode: 'disabled' }));
    created.push(server);
    expect(server.oidc.status).toBe('disabled');

    server.authConfig.current = makeOidcConfig({
      issuerUrl,
      appBaseUrl: 'http://127.0.0.1:8080',
    });
    await server.oidc.reconfigure();

    expect(server.oidc.status).toBe('connected');
    expect(server.oidc.config).not.toBeNull();
    expect(server.oidc.lastError).toBeNull();
    expect(server.oidc.redirectUri).toBe('http://127.0.0.1:8080/api/auth/callback');
  });

  it('a stale successful discovery cannot resurrect connected state after reconfigure() disables oidc (generation guard)', async () => {
    const slow = createControllableIssuer();
    const origin = await slow.originPromise;

    try {
      const server = await buildTestServer(makeOidcConfig({ issuerUrl: origin }));
      created.push(server);

      // Wait for the boot-time tryDiscover() to actually reach (and be held
      // open by) the controllable issuer.
      await slow.requested;

      // Switch to disabled BEFORE the held discovery response is released.
      // This must bump the generation counter so the still-in-flight attempt
      // can no longer commit its result.
      server.authConfig.current = makeAuthConfig({ mode: 'disabled' });
      await server.oidc.reconfigure();
      expect(server.oidc.status).toBe('disabled');

      // Now release the held response as a (belated) discovery success.
      slow.respond(200);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The disabled state must not have been clobbered by the late success.
      expect(server.oidc.status).toBe('disabled');
      expect(server.oidc.config).toBeNull();
    } finally {
      await slow.close();
    }
  });

  it('a stale failing discovery cannot flip status back to unavailable after reconfigure() connects successfully (generation guard)', async () => {
    const slow = createControllableIssuer();
    const slowOrigin = await slow.originPromise;

    idp = new OAuth2Server();
    await idp.issuer.keys.generate('RS256');
    await idp.start(0, '127.0.0.1');
    const issuerUrl = idp.issuer.url as string;

    try {
      const server = await buildTestServer(makeOidcConfig({ issuerUrl: slowOrigin }));
      created.push(server);

      // Wait for the boot-time tryDiscover() to reach (and be held open by)
      // the controllable issuer before reconfiguring to a different,
      // reachable one.
      await slow.requested;

      server.authConfig.current = makeOidcConfig({
        issuerUrl,
        appBaseUrl: 'http://127.0.0.1:8080',
      });
      await server.oidc.reconfigure();

      expect(server.oidc.status).toBe('connected');

      // Now release the held (first, slow) request as a belated FAILURE,
      // simulating a slow discovery attempt that finally errors out after
      // reconfigure() already produced a fresh, successful result.
      slow.respond(500, { error: 'server_error' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(server.oidc.status).toBe('connected');
      expect(server.oidc.config).not.toBeNull();
      expect(server.oidc.lastError).toBeNull();
    } finally {
      await slow.close();
    }
  });
});

describe('sanitizeDiscoveryError', () => {
  it('redacts the client secret when a (hypothetical) error message contains it', () => {
    const err = new Error(
      'fetch failed: unexpected token near client_secret=lcm-test-secret&foo=1',
    );
    const message = sanitizeDiscoveryError(err, 'lcm-test-secret');
    expect(message).not.toContain('lcm-test-secret');
    expect(message).toContain('[redacted]');
  });

  it('passes the message through unchanged when it does not contain the secret', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:1');
    expect(sanitizeDiscoveryError(err, 'lcm-test-secret')).toBe('connect ECONNREFUSED 127.0.0.1:1');
  });

  it('handles a null clientSecret and non-Error thrown values without throwing', () => {
    expect(sanitizeDiscoveryError(new Error('boom'), null)).toBe('boom');
    expect(sanitizeDiscoveryError('not an Error instance', 'lcm-test-secret')).toBe(
      'Unknown error',
    );
  });
});

describe('testDiscovery', () => {
  it('returns { ok: true, error: null } against a reachable issuer, without persisting or mutating any plugin state', async () => {
    const issuer = createControllableIssuer();
    const origin = await issuer.originPromise;

    try {
      const resultPromise = testDiscovery({
        issuerUrl: origin,
        clientId: 'lcm-test',
        clientSecret: 'lcm-test-distinctive-secret',
        allowInsecure: true,
      });
      await issuer.requested;
      issuer.respond(200);
      const result = await resultPromise;

      expect(result).toEqual({ ok: true, error: null });
    } finally {
      await issuer.close();
    }
  });

  it('returns { ok: false, error } with a non-empty, secret-free message against an unreachable issuer', async () => {
    const result = await testDiscovery({
      issuerUrl: 'http://127.0.0.1:1/oidc',
      clientId: 'lcm-test',
      clientSecret: 'lcm-test-distinctive-secret',
      allowInsecure: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toEqual(expect.any(String));
    expect(result.error).not.toHaveLength(0);
    expect(result.error).not.toContain('lcm-test-distinctive-secret');
  });

  it('rejects a private/loopback issuer host before any request when allowInsecure=false (#125 SSRF)', async () => {
    const result = await testDiscovery({
      issuerUrl: 'https://127.0.0.1/oidc',
      clientId: 'lcm-test',
      clientSecret: 'lcm-test-distinctive-secret',
      allowInsecure: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/private, loopback, or link-local/i);
  });
});

describe('isPrivateAddress (#125 SSRF deny-list)', () => {
  it('flags loopback, private, link-local, CGNAT and unspecified addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '::1',
      'fc00::1',
      'fd12::34',
      'fe80::1',
      '::ffff:127.0.0.1', // IPv4-mapped loopback
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it('does not flag public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });

  it('fails closed for a malformed literal', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('issuerTargetsInternalAddress (#125 SSRF deny-list)', () => {
  it('flags IP-literal internal hosts (v4 and bracketed v6)', async () => {
    expect(await issuerTargetsInternalAddress('https://127.0.0.1/oidc')).toBe(true);
    expect(await issuerTargetsInternalAddress('https://[::1]/oidc')).toBe(true);
  });

  it('flags hostnames that resolve to loopback (localhost)', async () => {
    expect(await issuerTargetsInternalAddress('https://localhost/oidc')).toBe(true);
  });

  it('does not flag a public IP literal, and returns false for an unparseable URL', async () => {
    expect(await issuerTargetsInternalAddress('https://8.8.8.8/oidc')).toBe(false);
    expect(await issuerTargetsInternalAddress('not a url')).toBe(false);
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
