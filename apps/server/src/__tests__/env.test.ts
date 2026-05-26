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
