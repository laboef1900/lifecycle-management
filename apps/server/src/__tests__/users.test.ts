import { describe, expect, it } from 'vitest';

import { UserService, computeRole, isEmailAllowed } from '../services/users.js';
import { prisma } from './setup.js';
import { makeOidcTestEnv } from './test-helpers.js';

describe('computeRole', () => {
  it('returns the default role when no role claim is configured', () => {
    expect(computeRole({}, makeOidcTestEnv())).toBe('ADMIN');
    expect(computeRole({}, makeOidcTestEnv({ OIDC_DEFAULT_ROLE: 'viewer' }))).toBe('VIEWER');
  });

  it('maps a configured claim against OIDC_ADMIN_VALUES (string and array claims)', () => {
    const env = makeOidcTestEnv({
      OIDC_ROLE_CLAIM: 'groups',
      OIDC_ADMIN_VALUES: 'lcm-admins, ops',
    });
    expect(computeRole({ groups: ['users', 'lcm-admins'] }, env)).toBe('ADMIN');
    expect(computeRole({ groups: 'ops' }, env)).toBe('ADMIN');
    expect(computeRole({ groups: ['users'] }, env)).toBe('VIEWER');
    expect(computeRole({}, env)).toBe('VIEWER');
  });
});

describe('isEmailAllowed', () => {
  it('allows everyone when no allowlist is configured', () => {
    expect(isEmailAllowed('anyone@evil.com', makeOidcTestEnv())).toBe(true);
    expect(isEmailAllowed(undefined, makeOidcTestEnv())).toBe(true);
  });

  it('enforces emails and domains case-insensitively; no email fails closed', () => {
    const env = makeOidcTestEnv({
      OIDC_ALLOWED_EMAILS: 'Boss@Example.com',
      OIDC_ALLOWED_EMAIL_DOMAINS: 'corp.example.org',
    });
    expect(isEmailAllowed('boss@example.com', env)).toBe(true);
    expect(isEmailAllowed('dev@CORP.example.org', env)).toBe(true);
    expect(isEmailAllowed('dev@example.com', env)).toBe(false);
    expect(isEmailAllowed(undefined, env)).toBe(false);
  });
});

describe('UserService.upsertFromIdentity', () => {
  it('creates on first login and updates profile/role/lastLoginAt on the next', async () => {
    const service = new UserService(prisma);
    const env = makeOidcTestEnv({ OIDC_ROLE_CLAIM: 'groups', OIDC_ADMIN_VALUES: 'lcm-admins' });
    const identity = {
      issuer: 'https://idp.test',
      subject: 'sub-42',
      email: 'ada@example.com',
      name: 'Ada',
      claims: { groups: ['lcm-admins'] },
    };

    const created = await service.upsertFromIdentity(identity, env);
    expect(created).toMatchObject({ role: 'ADMIN', email: 'ada@example.com', tenantId: 'default' });
    expect(created.lastLoginAt).not.toBeNull();

    const updated = await service.upsertFromIdentity(
      { ...identity, name: 'Ada L.', claims: { groups: [] } },
      env,
    );
    expect(updated.id).toBe(created.id);
    expect(updated).toMatchObject({ role: 'VIEWER', displayName: 'Ada L.' });
  });
});
