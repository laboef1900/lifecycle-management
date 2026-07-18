import { describe, expect, it, vi } from 'vitest';

import { encrypt, loadKey } from '../crypto/secret-box.js';
import { prisma } from './setup.js';
import { makeOidcTestEnv, makeTestEnv } from './test-helpers.js';
import {
  AuthConfigService,
  AuthSecretDecryptError,
  type EffectiveAuthConfig,
} from '../services/auth-config.js';

const KEY = loadKey(Buffer.alloc(32, 7).toString('base64'));
const WRONG_KEY = loadKey(Buffer.alloc(32, 9).toString('base64'));

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
    // The '*' cannot occur in the stored value (base64 segments joined by '.'),
    // so the encrypted-at-rest assertion below is deterministic — a plain-word
    // marker like 'shh' can appear in random base64 ciphertext by chance.
    const plaintextSecret = 'shh*plaintext*marker';
    const svc = new AuthConfigService(prisma, KEY);
    const cfg = await svc.load(
      makeOidcTestEnv({
        OIDC_ISSUER_URL: 'https://idp',
        OIDC_CLIENT_ID: 'lcm',
        OIDC_CLIENT_SECRET: plaintextSecret,
        APP_BASE_URL: 'https://app',
        OIDC_SCOPES: 'openid profile email',
        OIDC_DEFAULT_ROLE: 'admin',
      }),
    );
    expect(cfg.mode).toBe('oidc');
    expect(cfg.clientId).toBe('lcm');
    expect(cfg.clientSecret).toBe(plaintextSecret); // decrypted in-memory
    expect(cfg.signingSecret).not.toBeNull(); // app-generated, not from LOGIN_STATE_SECRET
    expect(cfg.signingSecret).not.toBe('test-login-state-secret-0123456789abcdef');
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.clientSecretEnc).not.toBeNull();
    expect(row!.clientSecretEnc).not.toContain(plaintextSecret); // encrypted at rest
    expect(row!.signingSecretEnc).not.toBeNull();
  });

  it('seeds as disabled (never crashing) when the key is null even though env has OIDC vars and a client secret', async () => {
    const warn = vi.fn();
    const svc = new AuthConfigService(prisma, null, { warn });

    const cfg = await svc.load(makeOidcTestEnv());

    expect(cfg.mode).toBe('disabled');
    expect(cfg.clientSecret).toBeNull();
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row).not.toBeNull();
    expect(row!.mode).toBe('disabled');
    // The secret can't be stored without a key, and enabling oidc without
    // one stored would be unsafe — so it must not be persisted at all.
    expect(row!.clientSecretEnc).toBeNull();
    // The security-relevant warning goes through the structured logger, not console.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth_config.seeded_disabled_no_key' }),
      expect.stringContaining('CONFIG_ENCRYPTION_KEY'),
    );
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

  it('throws a clear AuthSecretDecryptError when a secret column is set but the key is null', async () => {
    await prisma.authConfig.create({
      data: { id: 'singleton', mode: 'oidc', clientSecretEnc: 'x.y.z' },
    });
    const svc = new AuthConfigService(prisma, null);
    await expect(svc.load()).rejects.toThrow(/CONFIG_ENCRYPTION_KEY/);
    await expect(svc.load()).rejects.toBeInstanceOf(AuthSecretDecryptError);
  });

  it('throws AuthSecretDecryptError (not a raw GCM error) when the configured key is wrong (rotated) rather than null', async () => {
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'oidc',
        clientSecretEnc: encrypt('super-secret', KEY),
        signingSecretEnc: encrypt('signing-secret-value', KEY),
      },
    });
    // A non-null key that is nonetheless the WRONG one for this ciphertext —
    // the key-rotation scenario. Node's generic GCM auth-tag error must be
    // normalized to AuthSecretDecryptError, not leak through as-is.
    const svc = new AuthConfigService(prisma, WRONG_KEY);
    await expect(svc.load()).rejects.toBeInstanceOf(AuthSecretDecryptError);
    // The raw Node crypto message must not be what callers match on — assert
    // our own message is present instead, and that it never contains the key
    // material.
    await expect(svc.load()).rejects.toThrow(/could not be decrypted/);
  });

  it("throws from toEffective's own decrypt guard (not load()'s upgrade-path guard) when a disabled row has a secret set", async () => {
    // mode: 'disabled' means load()'s upgrade-path guard
    // (`row.mode === 'oidc' && !row.signingSecretEnc`) never fires here, so
    // the only way this can throw is toEffective's decryptColumn guard
    // running unconditionally over row.clientSecretEnc regardless of mode.
    await prisma.authConfig.create({
      data: { id: 'singleton', mode: 'disabled', clientSecretEnc: 'x.y.z' },
    });
    const svc = new AuthConfigService(prisma, null);
    await expect(svc.load()).rejects.toThrow(
      /AuthConfig has a stored client secret but CONFIG_ENCRYPTION_KEY is not configured; cannot decrypt/,
    );
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

  it('leaves an omitted non-secret nullable field (roleClaim) unchanged, distinguishing undefined-skip from null-clear', async () => {
    const svc = new AuthConfigService(prisma, KEY);
    await svc.update(
      {
        mode: 'oidc',
        clientId: 'a',
        clientSecret: 'x',
        issuerUrl: null,
        appBaseUrl: null,
        scopes: 'openid profile email',
        roleClaim: 'groups',
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
        clientId: 'a',
        clientSecret: 'x',
        issuerUrl: null,
        appBaseUrl: null,
        scopes: 'openid profile email',
        adminValues: null,
        defaultRole: 'admin',
        allowedEmailDomains: null,
        allowedEmails: null,
        sessionTtlHours: 12,
        allowInsecure: false,
        // roleClaim omitted entirely
      },
      null,
    );
    const cfg = await svc.load();
    expect(cfg.roleClaim).toBe('groups');
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

  it('regenerates the signing secret on re-enabling oidc when the existing one cannot be decrypted under the current key (key-rotation UI recovery)', async () => {
    // Simulate: oidc was configured under K1, then CONFIG_ENCRYPTION_KEY was
    // rotated to K2 (a service now built with K2 can no longer decrypt
    // either secret column written under K1).
    const staleSigningSecretEnc = encrypt('signing-secret-under-old-key', KEY);
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'disabled', // boot's fail-safe guard already forced this
        clientId: 'lcm',
        issuerUrl: 'https://idp',
        appBaseUrl: 'https://app',
        clientSecretEnc: encrypt('old-client-secret', KEY),
        signingSecretEnc: staleSigningSecretEnc,
      },
    });

    const svc = new AuthConfigService(prisma, WRONG_KEY);
    // The documented recovery: admin re-enters the client secret and saves.
    await svc.update(
      {
        mode: 'oidc',
        clientId: 'lcm',
        clientSecret: 're-entered-secret',
        issuerUrl: 'https://idp',
        appBaseUrl: 'https://app',
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
    expect(row!.mode).toBe('oidc');
    // The stale (undecryptable-under-WRONG_KEY) signing secret must have been
    // replaced, not kept as-is.
    expect(row!.signingSecretEnc).not.toBeNull();
    expect(row!.signingSecretEnc).not.toBe(staleSigningSecretEnc);

    // The key proof: load()/toEffective() (what the settings route's
    // reload() calls) must now succeed under the new key instead of throwing
    // AuthSecretDecryptError, with both secrets decrypting cleanly.
    const cfg = await svc.load();
    expect(cfg.mode).toBe('oidc');
    expect(cfg.clientSecret).toBe('re-entered-secret');
    expect(cfg.signingSecret).not.toBeNull();
  });

  it('does NOT rotate a valid existing signing secret on a normal oidc save (no key change)', async () => {
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
      null,
    );
    const before = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    const signingSecretEncBefore = before!.signingSecretEnc;
    expect(signingSecretEncBefore).not.toBeNull();

    // A no-op-secret save (clientSecret omitted, same key) must leave the
    // signing secret completely untouched — it's still decryptable under the
    // current key, so canDecrypt() must short-circuit the regeneration.
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
    const after = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(after!.signingSecretEnc).toBe(signingSecretEncBefore);
  });
});

describe('AuthConfigService.toEffective', () => {
  it('maps a local-mode row to effective mode "local"', async () => {
    const svc = new AuthConfigService(prisma, null);
    const row = await prisma.authConfig.create({ data: { id: 'singleton', mode: 'local' } });
    expect(svc.toEffective(row).mode).toBe('local');
  });
});

describe('AuthConfigService.sanitize', () => {
  /**
   * What every in-memory force-disable looks like on the wire: the ENFORCED
   * mode is `disabled` while the stored mode is `oidc`.
   */
  const divergentEffective: EffectiveAuthConfig = {
    mode: 'disabled',
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
      svc.sanitize(
        eff,
        { storedMode: 'oidc', overrideCause: null },
        'https://app/api/auth/callback',
        'connected',
        null,
      ),
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
    const out = svc.sanitize(
      eff,
      { storedMode: 'disabled', overrideCause: null },
      'https://app/api/auth/callback',
      'disabled',
      'boom',
    );
    expect(out.clientSecretSet).toBe(false);
    expect(out.signingSecretSet).toBe(false);
    expect(out.lastDiscoveryError).toBe('boom');
    expect(out.discoveryStatus).toBe('disabled');
  });

  it('reports the STORED mode plus forceDisabledReason, not the enforced mode (#222)', () => {
    const svc = new AuthConfigService(prisma, KEY);
    // What a break-glass boot looks like: enforced disabled, stored oidc.
    const eff: EffectiveAuthConfig = {
      mode: 'disabled',
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

    const out = svc.sanitize(
      eff,
      { storedMode: 'oidc', overrideCause: 'break_glass' },
      'https://app/api/auth/callback',
      'disabled',
      null,
    );

    // Reporting the enforced 'disabled' here would make the Settings form echo
    // it back in its PUT and clobber the stored oidc config.
    expect(out.mode).toBe('oidc');
    expect(out.forceDisabledReason).toBe('break_glass');
  });

  it('reports forceDisabledReason=secret_decrypt_failure for the decrypt degrade (#222)', () => {
    const svc = new AuthConfigService(prisma, KEY);
    // The decrypt degrade produces the SAME divergence as break-glass, but with
    // break-glass OFF. Gating the indicator on break-glass alone answered
    // {mode:'oidc', no indicator} over an anonymous-ADMIN API.
    const out = svc.sanitize(
      { ...divergentEffective },
      { storedMode: 'oidc', overrideCause: 'secret_decrypt_failure' },
      'https://app/api/auth/callback',
      'disabled',
      null,
    );

    expect(out.mode).toBe('oidc');
    expect(out.forceDisabledReason).toBe('secret_decrypt_failure');
  });

  it('reports a divergence with NO recorded cause conservatively, never as null (#222)', () => {
    const svc = new AuthConfigService(prisma, KEY);
    // A divergence with no recorded cause is a plugin bug. Failing safe means
    // still flagging it: reporting null would render a secured-looking OIDC page
    // over a wide-open API, the exact failure this field prevents.
    const out = svc.sanitize(
      { ...divergentEffective },
      { storedMode: 'oidc', overrideCause: null },
      'https://app/api/auth/callback',
      'disabled',
      null,
    );

    expect(out.forceDisabledReason).toBe('secret_decrypt_failure');
  });

  it('reports forceDisabledReason=null when a cause is recorded but nothing actually diverges (#222)', () => {
    const svc = new AuthConfigService(prisma, KEY);
    // The FALSE-POSITIVE direction, and the only fixture here that a hardcoded
    // non-null implementation fails: break-glass over a deployment whose stored
    // mode is ALREADY `disabled`. A cause IS recorded (the override genuinely
    // fired), but enforced and stored agree, so there is no "open despite
    // configuration" to report. Deriving the reason from `overrideCause` alone
    // would put a force-disabled banner on the app's documented default
    // posture — banner blindness on every fresh deployment.
    const out = svc.sanitize(
      { ...divergentEffective, mode: 'disabled' },
      { storedMode: 'disabled', overrideCause: 'break_glass' },
      'https://app/api/auth/callback',
      'disabled',
      null,
    );

    expect(out.mode).toBe('disabled');
    expect(out.forceDisabledReason).toBeNull();
  });

  it('reports forceDisabledReason=null when the enforced mode matches the stored one', () => {
    const svc = new AuthConfigService(prisma, KEY);

    const enforcedOidc = svc.sanitize(
      { ...divergentEffective, mode: 'oidc' },
      { storedMode: 'oidc', overrideCause: null },
      'https://app/api/auth/callback',
      'connected',
      null,
    );
    expect(enforcedOidc.forceDisabledReason).toBeNull();

    // A deployment legitimately stored as `disabled` is NOT a divergence, even
    // though the enforced mode is `disabled` — it must report null.
    const storedDisabled = svc.sanitize(
      { ...divergentEffective, mode: 'disabled' },
      { storedMode: 'disabled', overrideCause: null },
      'https://app/api/auth/callback',
      'disabled',
      null,
    );
    expect(storedDisabled.forceDisabledReason).toBeNull();
  });
});
