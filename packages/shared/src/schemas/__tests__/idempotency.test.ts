import { describe, expect, it } from 'vitest';

import { idempotencyKeyHeaderSchema } from '../idempotency.js';

describe('idempotencyKeyHeaderSchema', () => {
  it('accepts a v4 UUID string', () => {
    expect(idempotencyKeyHeaderSchema.parse('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it('rejects a non-UUID string', () => {
    expect(() => idempotencyKeyHeaderSchema.parse('not-a-uuid')).toThrow();
  });

  it('rejects undefined (missing header)', () => {
    expect(() => idempotencyKeyHeaderSchema.parse(undefined)).toThrow();
  });

  it('rejects an array (duplicate header)', () => {
    expect(() => idempotencyKeyHeaderSchema.parse(['a', 'b'])).toThrow();
  });
});
