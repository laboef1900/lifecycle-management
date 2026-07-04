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
    expect(authConfigResponseSchema.safeParse({ discoveryStatus: 'nope' }).success).toBe(false);
  });
});
