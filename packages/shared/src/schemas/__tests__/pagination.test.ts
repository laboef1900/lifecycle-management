import { describe, expect, it } from 'vitest';

import { paginationQuerySchema } from '../pagination.js';

describe('paginationQuerySchema', () => {
  it('applies defaults when parsing an empty object', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 100, offset: 0 });
  });

  it('rejects limit above the max of 500', () => {
    expect(paginationQuerySchema.safeParse({ limit: 1000 }).success).toBe(false);
  });

  it('rejects negative offsets', () => {
    expect(paginationQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
  });
});
