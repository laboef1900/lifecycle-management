import { describe, expect, it } from 'vitest';

import type { EffectiveAuthConfig } from '../services/auth-config.js';
import { UserService, computeRole, isEmailAllowed } from '../services/users.js';
import { prisma } from './setup.js';

/** Minimal EffectiveAuthConfig fixture for users-service tests. */
function makeTestConfig(overrides: Partial<EffectiveAuthConfig> = {}): EffectiveAuthConfig {
  return {
    mode: 'oidc',
    issuerUrl: 'http://127.0.0.1:1/oidc',
    clientId: 'lcm-test',
    clientSecret: 'lcm-test-secret',
    signingSecret: 'test-signing-secret',
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

describe('computeRole', () => {
  it('returns the default role when no role claim is configured', () => {
    expect(computeRole({}, makeTestConfig())).toBe('ADMIN');
    expect(computeRole({}, makeTestConfig({ defaultRole: 'viewer' }))).toBe('VIEWER');
  });

  it('maps a configured claim against adminValues (string and array claims)', () => {
    const cfg = makeTestConfig({
      roleClaim: 'groups',
      adminValues: 'lcm-admins, ops',
    });
    expect(computeRole({ groups: ['users', 'lcm-admins'] }, cfg)).toBe('ADMIN');
    expect(computeRole({ groups: 'ops' }, cfg)).toBe('ADMIN');
    expect(computeRole({ groups: ['users'] }, cfg)).toBe('VIEWER');
    expect(computeRole({}, cfg)).toBe('VIEWER');
  });
});

describe('isEmailAllowed', () => {
  it('allows everyone when no allowlist is configured', () => {
    expect(isEmailAllowed('anyone@evil.com', makeTestConfig())).toBe(true);
    expect(isEmailAllowed(undefined, makeTestConfig())).toBe(true);
  });

  it('enforces emails and domains case-insensitively; no email fails closed', () => {
    const cfg = makeTestConfig({
      allowedEmails: 'Boss@Example.com',
      allowedEmailDomains: 'corp.example.org',
    });
    expect(isEmailAllowed('boss@example.com', cfg)).toBe(true);
    expect(isEmailAllowed('dev@CORP.example.org', cfg)).toBe(true);
    expect(isEmailAllowed('dev@example.com', cfg)).toBe(false);
    expect(isEmailAllowed(undefined, cfg)).toBe(false);
  });
});

describe('UserService.upsertFromIdentity', () => {
  it('creates on first login and updates profile/role/lastLoginAt on the next', async () => {
    const service = new UserService(prisma);
    const cfg = makeTestConfig({ roleClaim: 'groups', adminValues: 'lcm-admins' });
    const identity = {
      issuer: 'https://idp.test',
      subject: 'sub-42',
      email: 'ada@example.com',
      name: 'Ada',
      claims: { groups: ['lcm-admins'] },
    };

    const created = await service.upsertFromIdentity(identity, cfg);
    expect(created).toMatchObject({ role: 'ADMIN', email: 'ada@example.com', tenantId: 'default' });
    expect(created.lastLoginAt).not.toBeNull();

    const updated = await service.upsertFromIdentity(
      { ...identity, name: 'Ada L.', claims: { groups: [] } },
      cfg,
    );
    expect(updated.id).toBe(created.id);
    expect(updated).toMatchObject({ role: 'VIEWER', displayName: 'Ada L.' });
  });
});
