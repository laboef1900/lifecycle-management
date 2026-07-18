import { describe, expect, it } from 'vitest';
import { authConfigUpdateSchema, authConfigResponseSchema } from '../auth-config.js';

describe('authConfigUpdateSchema', () => {
  it('accepts a full oidc config with a client secret', () => {
    const r = authConfigUpdateSchema.safeParse({
      mode: 'oidc',
      issuerUrl: 'https://idp.example.com/realms/lcm',
      clientId: 'lcm',
      clientSecret: 'shhh',
      appBaseUrl: 'https://lcm.example.com',
      scopes: 'openid profile email',
      defaultRole: 'admin',
      sessionTtlHours: 12,
      allowInsecure: false,
    });
    expect(r.success).toBe(true);
  });
  it('omitting clientSecret is allowed (unchanged); null clears it', () => {
    expect(authConfigUpdateSchema.safeParse({ mode: 'disabled' }).success).toBe(true);
    expect(authConfigUpdateSchema.safeParse({ mode: 'disabled', clientSecret: null }).success).toBe(
      true,
    );
  });
  it('rejects a bad issuer url and out-of-range ttl', () => {
    expect(authConfigUpdateSchema.safeParse({ mode: 'oidc', issuerUrl: 'not-a-url' }).success).toBe(
      false,
    );
    expect(authConfigUpdateSchema.safeParse({ mode: 'oidc', sessionTtlHours: 0 }).success).toBe(
      false,
    );
    expect(authConfigUpdateSchema.safeParse({ mode: 'oidc', sessionTtlHours: 1000 }).success).toBe(
      false,
    );
  });
});

describe('authConfigResponseSchema', () => {
  it('parses a sanitized response and tolerates an extra field', () => {
    const r = authConfigResponseSchema.safeParse({
      mode: 'oidc',
      forceDisabledReason: null,
      issuerUrl: 'https://x',
      clientId: 'lcm',
      appBaseUrl: 'https://a',
      scopes: 'openid',
      roleClaim: null,
      adminValues: null,
      defaultRole: 'admin',
      allowedEmailDomains: null,
      allowedEmails: null,
      sessionTtlHours: 12,
      allowInsecure: false,
      clientSecretSet: true,
      signingSecretSet: true,
      redirectUri: 'https://a/api/auth/callback',
      discoveryStatus: 'connected',
      lastDiscoveryError: null,
      futureField: 1,
    });
    expect(r.success).toBe(true);
  });
  it('rejects a bad discoveryStatus', () => {
    const r = authConfigResponseSchema.safeParse({
      mode: 'oidc',
      forceDisabledReason: null,
      issuerUrl: 'https://x',
      clientId: 'lcm',
      appBaseUrl: 'https://a',
      scopes: 'openid',
      roleClaim: null,
      adminValues: null,
      defaultRole: 'admin',
      allowedEmailDomains: null,
      allowedEmails: null,
      sessionTtlHours: 12,
      allowInsecure: false,
      clientSecretSet: true,
      signingSecretSet: true,
      redirectUri: 'https://a/api/auth/callback',
      discoveryStatus: 'nope',
      lastDiscoveryError: null,
    });
    expect(r.success).toBe(false);
  });
});

describe('authConfigResponseSchema forceDisabledReason (#222)', () => {
  const breakGlassResponse = {
    // the STORED mode, reported unmasked while the enforced mode is `disabled`
    mode: 'oidc',
    forceDisabledReason: 'break_glass',
    issuerUrl: 'https://idp.example.com/realms/lcm',
    clientId: 'lcm',
    appBaseUrl: 'https://lcm.example.com',
    scopes: 'openid profile email',
    roleClaim: null,
    adminValues: null,
    defaultRole: 'admin',
    allowedEmailDomains: null,
    allowedEmails: null,
    sessionTtlHours: 12,
    allowInsecure: false,
    clientSecretSet: true,
    signingSecretSet: true,
    redirectUri: 'https://lcm.example.com/api/auth/callback',
    discoveryStatus: 'disabled',
    lastDiscoveryError: null,
  };

  it('carries the stored mode alongside forceDisabledReason=break_glass', () => {
    const r = authConfigResponseSchema.safeParse(breakGlassResponse);
    expect(r.success).toBe(true);
    expect(r.data?.mode).toBe('oidc');
    expect(r.data?.forceDisabledReason).toBe('break_glass');
  });

  it('carries the stored mode alongside forceDisabledReason=secret_decrypt_failure', () => {
    // The decrypt degrade produces the SAME divergence as break-glass — an
    // enforced `disabled` under a stored `oidc` — and must be just as reportable.
    const r = authConfigResponseSchema.safeParse({
      ...breakGlassResponse,
      forceDisabledReason: 'secret_decrypt_failure',
    });
    expect(r.success).toBe(true);
    expect(r.data?.forceDisabledReason).toBe('secret_decrypt_failure');
  });

  it('rejects a response that omits forceDisabledReason', () => {
    const { forceDisabledReason: _omitted, ...withoutReason } = breakGlassResponse;
    expect(authConfigResponseSchema.safeParse(withoutReason).success).toBe(false);
  });

  it('rejects an unknown forceDisabledReason', () => {
    expect(
      authConfigResponseSchema.safeParse({ ...breakGlassResponse, forceDisabledReason: 'whatever' })
        .success,
    ).toBe(false);
    expect(
      authConfigResponseSchema.safeParse({ ...breakGlassResponse, forceDisabledReason: true })
        .success,
    ).toBe(false);
  });
});
