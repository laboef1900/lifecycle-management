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

  it('accepts AUTH_MODE=oidc with no OIDC vars set: the DB is authoritative, env is seed-only', () => {
    const env = parseEnv({ ...base, AUTH_MODE: 'oidc' });
    expect(env.AUTH_MODE).toBe('oidc');
    expect(env.OIDC_ISSUER_URL).toBeUndefined();
  });

  it('accepts OIDC vars present without an explicit AUTH_MODE (seed-only, no fail-closed check)', () => {
    const env = parseEnv({ ...base, ...oidcVars });
    expect(env.AUTH_MODE).toBe('disabled');
    expect(env.OIDC_ISSUER_URL).toBe(oidcVars.OIDC_ISSUER_URL);
  });

  it('allows explicit AUTH_MODE=disabled with OIDC vars present (escape hatch)', () => {
    const env = parseEnv({ ...base, AUTH_MODE: 'disabled', ...oidcVars });
    expect(env.AUTH_MODE).toBe('disabled');
  });

  it('rejects a LOGIN_STATE_SECRET shorter than 32 chars when provided', () => {
    expect(() =>
      parseEnv({ ...base, AUTH_MODE: 'oidc', ...oidcVars, LOGIN_STATE_SECRET: 'short' }),
    ).toThrowError(/LOGIN_STATE_SECRET/);
  });

  it('parses AUTH_MODE case-insensitively (AUTH_MODE=OIDC)', () => {
    expect(parseEnv({ ...base, AUTH_MODE: 'OIDC', ...oidcVars }).AUTH_MODE).toBe('oidc');
    expect(parseEnv({ ...base, AUTH_MODE: 'Disabled' }).AUTH_MODE).toBe('disabled');
  });

  it('parses OIDC_DEFAULT_ROLE case-insensitively', () => {
    expect(parseEnv({ ...base, OIDC_DEFAULT_ROLE: 'VIEWER' }).OIDC_DEFAULT_ROLE).toBe('viewer');
    expect(parseEnv({ ...base, OIDC_DEFAULT_ROLE: 'Admin' }).OIDC_DEFAULT_ROLE).toBe('admin');
  });

  it('parses OIDC_ALLOW_INSECURE case-insensitively (TRUE -> true)', () => {
    expect(parseEnv({ ...base, OIDC_ALLOW_INSECURE: 'TRUE' }).OIDC_ALLOW_INSECURE).toBe(true);
    expect(parseEnv({ ...base, OIDC_ALLOW_INSECURE: 'False' }).OIDC_ALLOW_INSECURE).toBe(false);
  });
});

describe('CONFIG_ENCRYPTION_KEY / RECOVERY_DISABLE_AUTH', () => {
  const base = { DATABASE_URL: 'postgresql://lcm:lcm@localhost:5432/lcm' };

  it('defaults RECOVERY_DISABLE_AUTH to false when unset', () => {
    const env = parseEnv(base);
    expect(env.RECOVERY_DISABLE_AUTH).toBe(false);
  });

  it('parses RECOVERY_DISABLE_AUTH=true as boolean true', () => {
    const env = parseEnv({ ...base, RECOVERY_DISABLE_AUTH: 'true' });
    expect(env.RECOVERY_DISABLE_AUTH).toBe(true);
  });

  it('treats an empty RECOVERY_DISABLE_AUTH string as absent (defaults to false)', () => {
    const env = parseEnv({ ...base, RECOVERY_DISABLE_AUTH: '' });
    expect(env.RECOVERY_DISABLE_AUTH).toBe(false);
  });

  it('passes CONFIG_ENCRYPTION_KEY through when set', () => {
    const key = Buffer.from('x'.repeat(32)).toString('base64');
    const env = parseEnv({ ...base, CONFIG_ENCRYPTION_KEY: key });
    expect(env.CONFIG_ENCRYPTION_KEY).toBe(key);
  });

  it('leaves CONFIG_ENCRYPTION_KEY undefined when unset', () => {
    const env = parseEnv(base);
    expect(env.CONFIG_ENCRYPTION_KEY).toBeUndefined();
  });
});
