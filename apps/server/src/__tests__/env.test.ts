import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from '../env.js';

describe('parseEnv', () => {
  it('parses a valid environment with defaults', () => {
    const env = parseEnv({ DATABASE_URL: 'postgresql://x:y@localhost:5432/z' });
    expect(env.DATABASE_URL).toBe('postgresql://x:y@localhost:5432/z');
    expect(env.PORT).toBe(8080);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces PORT from string', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
      PORT: '9090',
    });
    expect(env.PORT).toBe(9090);
  });

  it('throws EnvValidationError on missing DATABASE_URL', () => {
    expect(() => parseEnv({})).toThrowError(EnvValidationError);
  });

  it('throws EnvValidationError on invalid DATABASE_URL', () => {
    expect(() => parseEnv({ DATABASE_URL: 'not-a-url' })).toThrowError(EnvValidationError);
  });

  it('rejects unknown LOG_LEVEL', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
        LOG_LEVEL: 'verbose',
      }),
    ).toThrowError(EnvValidationError);
  });

  it('rejects PORT outside the valid range', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
        PORT: '99999',
      }),
    ).toThrowError(EnvValidationError);
  });
});

describe('AUTH_MODE / OIDC configuration', () => {
  const base = { DATABASE_URL: 'postgresql://lcm:lcm@localhost:5432/lcm' };

  const oidcVars = {
    OIDC_ISSUER_URL: 'https://idp.example.com/realms/lcm',
    OIDC_CLIENT_ID: 'lcm',
    OIDC_CLIENT_SECRET: 'secret',
    APP_BASE_URL: 'https://lcm.example.com',
    LOGIN_STATE_SECRET: 'x'.repeat(32),
  };

  it('defaults to disabled with sensible auth defaults', () => {
    const env = parseEnv(base);
    expect(env.AUTH_MODE).toBe('disabled');
    expect(env.SESSION_TTL_HOURS).toBe(12);
    expect(env.OIDC_SCOPES).toBe('openid profile email');
    expect(env.OIDC_DEFAULT_ROLE).toBe('admin');
    expect(env.OIDC_ALLOW_INSECURE).toBe(false);
  });

  it('treats empty strings from compose as absent', () => {
    const env = parseEnv({ ...base, AUTH_MODE: '', OIDC_ISSUER_URL: '', OIDC_CLIENT_ID: '' });
    expect(env.AUTH_MODE).toBe('disabled');
    expect(env.OIDC_ISSUER_URL).toBeUndefined();
  });

  it('accepts a complete oidc configuration', () => {
    const env = parseEnv({ ...base, AUTH_MODE: 'oidc', ...oidcVars });
    expect(env.AUTH_MODE).toBe('oidc');
    expect(env.OIDC_ISSUER_URL).toBe(oidcVars.OIDC_ISSUER_URL);
  });

  it('rejects AUTH_MODE=oidc with missing vars, naming each one', () => {
    expect(() => parseEnv({ ...base, AUTH_MODE: 'oidc' })).toThrowError(
      /OIDC_ISSUER_URL[\s\S]*OIDC_CLIENT_ID[\s\S]*OIDC_CLIENT_SECRET[\s\S]*APP_BASE_URL[\s\S]*LOGIN_STATE_SECRET/,
    );
  });

  it('fails closed: OIDC vars present without an explicit AUTH_MODE refuses to boot', () => {
    expect(() => parseEnv({ ...base, ...oidcVars })).toThrowError(
      /AUTH_MODE must be set explicitly/,
    );
  });

  it('allows explicit AUTH_MODE=disabled with OIDC vars present (escape hatch)', () => {
    const env = parseEnv({ ...base, AUTH_MODE: 'disabled', ...oidcVars });
    expect(env.AUTH_MODE).toBe('disabled');
  });

  it('rejects a LOGIN_STATE_SECRET shorter than 32 chars', () => {
    expect(() =>
      parseEnv({ ...base, AUTH_MODE: 'oidc', ...oidcVars, LOGIN_STATE_SECRET: 'short' }),
    ).toThrowError(/LOGIN_STATE_SECRET/);
  });
});
