import { describe, expect, it } from 'vitest';

import { generateUuidV4 } from './uuid';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateUuidV4', () => {
  it('produces a well-formed v4 UUID', () => {
    expect(generateUuidV4()).toMatch(UUID_V4_PATTERN);
  });

  it('produces a different value on each call', () => {
    expect(generateUuidV4()).not.toBe(generateUuidV4());
  });
});
