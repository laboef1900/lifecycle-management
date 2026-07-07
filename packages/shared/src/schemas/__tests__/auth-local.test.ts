import { describe, expect, it } from 'vitest';

import { createLocalUserSchema, localLoginSchema, passwordSchema } from '../auth-local.js';

describe('auth-local schemas', () => {
  it('accepts a valid local login', () => {
    expect(localLoginSchema.parse({ username: 'admin', password: 'hunter2hunter2' })).toEqual({
      username: 'admin',
      password: 'hunter2hunter2',
    });
  });

  it('rejects a short password', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('twelvechars!!').success).toBe(true);
  });

  it('rejects usernames with illegal characters and defaults role to ADMIN', () => {
    expect(
      createLocalUserSchema.safeParse({ username: 'a b', password: 'twelvechars!!' }).success,
    ).toBe(false);
    const ok = createLocalUserSchema.parse({ username: 'ops.admin', password: 'twelvechars!!' });
    expect(ok.role).toBe('ADMIN');
  });
});
