import { describe, expect, it } from 'vitest';

import { loadKey } from '../../crypto/secret-box.js';
import { prisma } from '../../__tests__/setup.js';
import { makeOidcTestEnv, makeTestEnv } from '../../__tests__/test-helpers.js';
import { AuthConfigService, type EffectiveAuthConfig } from '../auth-config.js';

const KEY = loadKey(Buffer.alloc(32, 7).toString('base64'));

describe('AuthConfigService.load', () => {
  it('creates a default disabled row on first load when no env + no key', async () => {
    const svc = new AuthConfigService(prisma, null);
    const cfg = await svc.load();
    expect(cfg.mode).toBe('disabled');
    expect(cfg.clientSecret).toBeNull();
    expect(cfg.signingSecret).toBeNull();
    expect(await prisma.authConfig.findUnique({ where: { id: 'singleton' } })).not.toBeNull();
  });

  it('seeds from env on first load, encrypting the client secret', async () => {
    const svc = new AuthConfigService(prisma, KEY);
    const cfg = await svc.load(
      makeOidcTestEnv({
        OIDC_ISSUER_URL: 'https://idp',
        OIDC_CLIENT_ID: 'lcm',
        OIDC_CLIENT_SECRET: 'shh',
        APP_BASE_URL: 'https://app',
        OIDC_SCOPES: 'openid profile email',
        OIDC_DEFAULT_ROLE: 'admin',
      }),
    );
    expect(cfg.mode).toBe('oidc');
    expect(cfg.clientId).toBe('lcm');
    expect(cfg.clientSecret).toBe('shh'); // decrypted in-memory
    expect(cfg.signingSecret).not.toBeNull(); // app-generated, not from LOGIN_STATE_SECRET
    expect(cfg.signingSecret).not.toBe('test-login-state-secret-0123456789abcdef');
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.clientSecretEnc).not.toBeNull();
    expect(row!.clientSecretEnc).not.toContain('shh'); // encrypted at rest
    expect(row!.signingSecretEnc).not.toBeNull();
  });

  it('does not seed when no OIDC env vars are present', async () => {
    const svc = new AuthConfigService(prisma, null);
    const cfg = await svc.load(makeTestEnv());
    expect(cfg.mode).toBe('disabled');
  });

  it('upgrades an existing oidc row that has no signing secret yet', async () => {
    await prisma.authConfig.create({
      data: { id: 'singleton', mode: 'oidc', clientId: 'legacy' },
    });
    const svc = new AuthConfigService(prisma, KEY);
    const cfg = await svc.load();
    expect(cfg.mode).toBe('oidc');
    expect(cfg.signingSecret).not.toBeNull();
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.signingSecretEnc).not.toBeNull();
  });

  it('throws a clear error when a secret column is set but the key is null', async () => {
    await prisma.authConfig.create({
      data: { id: 'singleton', mode: 'oidc', clientSecretEnc: 'x.y.z' },
    });
    const svc = new AuthConfigService(prisma, null);
    await expect(svc.load()).rejects.toThrow(/CONFIG_ENCRYPTION_KEY/);
  });
});

describe('AuthConfigService.update', () => {
  it('leaves an omitted secret unchanged, clears on null', async () => {
    const svc = new AuthConfigService(prisma, KEY);
    await svc.update(
      {
        mode: 'oidc',
        clientId: 'a',
        clientSecret: 'first',
        issuerUrl: null,
        appBaseUrl: null,
        scopes: 'openid profile email',
        roleClaim: null,
        adminValues: null,
        defaultRole: 'admin',
        allowedEmailDomains: null,
        allowedEmails: null,
        sessionTtlHours: 12,
        allowInsecure: false,
      },
      null,
    );
    await svc.update(
      {
        mode: 'oidc',
        clientId: 'b',
        issuerUrl: null,
        appBaseUrl: null,
        scopes: 'openid profile email',
        roleClaim: null,
        adminValues: null,
        defaultRole: 'admin',
        allowedEmailDomains: null,
        allowedEmails: null,
        sessionTtlHours: 12,
        allowInsecure: false,
        // clientSecret omitted entirely
      },
      null,
    ); // secret omitted
    const afterOmit = await svc.load();
    expect(afterOmit.clientSecret).toBe('first');
    expect(afterOmit.clientId).toBe('b');

    await svc.update(
      {
        mode: 'oidc',
        clientId: 'b',
        clientSecret: null,
        issuerUrl: null,
        appBaseUrl: null,
        scopes: 'openid profile email',
        roleClaim: null,
        adminValues: null,
        defaultRole: 'admin',
        allowedEmailDomains: null,
        allowedEmails: null,
        sessionTtlHours: 12,
        allowInsecure: false,
      },
      null,
    );
    const afterClear = await svc.load();
    expect(afterClear.clientSecret).toBeNull();
  });

  it('generates a signing secret when enabling oidc for the first time', async () => {
    const svc = new AuthConfigService(prisma, KEY);
    await svc.update(
      {
        mode: 'oidc',
        clientId: 'a',
        clientSecret: 'x',
        issuerUrl: null,
        appBaseUrl: null,
        scopes: 'openid profile email',
        roleClaim: null,
        adminValues: null,
        defaultRole: 'admin',
        allowedEmailDomains: null,
        allowedEmails: null,
        sessionTtlHours: 12,
        allowInsecure: false,
      },
      'user-1',
    );
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.signingSecretEnc).not.toBeNull();
    expect(row!.updatedByUserId).toBe('user-1');

    const firstSigningSecretEnc = row!.signingSecretEnc;
    // A second update while already oidc must NOT rotate the existing signing secret.
    await svc.update(
      {
        mode: 'oidc',
        clientId: 'a',
        issuerUrl: null,
        appBaseUrl: null,
        scopes: 'openid profile email',
        roleClaim: null,
        adminValues: null,
        defaultRole: 'admin',
        allowedEmailDomains: null,
        allowedEmails: null,
        sessionTtlHours: 12,
        allowInsecure: false,
      },
      null,
    );
    const rowAfter = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(rowAfter!.signingSecretEnc).toBe(firstSigningSecretEnc);
  });
});

describe('AuthConfigService.sanitize', () => {
  it('never includes secret values', () => {
    const svc = new AuthConfigService(prisma, KEY);
    const eff: EffectiveAuthConfig = {
      mode: 'oidc',
      issuerUrl: 'https://idp',
      clientId: 'lcm',
      clientSecret: 'client-secret-value-9f2a1',
      signingSecret: 'signing-secret-value-7d3c8',
      appBaseUrl: 'https://app',
      scopes: 'openid profile email',
      roleClaim: null,
      adminValues: null,
      defaultRole: 'admin',
      allowedEmailDomains: null,
      allowedEmails: null,
      sessionTtlHours: 12,
      allowInsecure: false,
    };
    const out = JSON.stringify(
      svc.sanitize(eff, 'https://app/api/auth/callback', 'connected', null),
    );
    // Assert on the full secret values (not a short substring like 'sig' —
    // that would coincidentally match inside the "signingSecretSet" key).
    expect(out).not.toContain('client-secret-value-9f2a1');
    expect(out).not.toContain('signing-secret-value-7d3c8');
    expect(out).toContain('"clientSecretSet":true');
    expect(out).toContain('"signingSecretSet":true');
  });

  it('reports clientSecretSet/signingSecretSet false when secrets are null', () => {
    const svc = new AuthConfigService(prisma, KEY);
    const eff: EffectiveAuthConfig = {
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
    };
    const out = svc.sanitize(eff, 'https://app/api/auth/callback', 'disabled', 'boom');
    expect(out.clientSecretSet).toBe(false);
    expect(out.signingSecretSet).toBe(false);
    expect(out.lastDiscoveryError).toBe('boom');
    expect(out.discoveryStatus).toBe('disabled');
  });
});
