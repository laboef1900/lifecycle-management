import { describe, expect, it } from 'vitest';
import { clustersListQuerySchema } from '../cluster.js';

describe('clustersListQuerySchema pagination defaults', () => {
  it('parses an empty query with pagination + includeArchived defaults', () => {
    expect(clustersListQuerySchema.parse({})).toEqual({
      limit: 100,
      offset: 0,
      includeArchived: false,
    });
  });

  it('rejects limit above the max of 500', () => {
    expect(clustersListQuerySchema.safeParse({ limit: 1000 }).success).toBe(false);
  });

  it('rejects negative offsets', () => {
    expect(clustersListQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
  });
});

describe('clustersListQuerySchema.includeArchived', () => {
  it.each([
    ['true', true],
    ['false', false],
    [undefined, false],
  ])('parses %s to %s', (wire, expected) => {
    const parsed = clustersListQuerySchema.parse(
      wire === undefined ? {} : { includeArchived: wire },
    );
    expect(parsed.includeArchived).toBe(expected);
  });
  it('rejects junk values', () => {
    expect(clustersListQuerySchema.safeParse({ includeArchived: 'yes' }).success).toBe(false);
    expect(clustersListQuerySchema.safeParse({ includeArchived: '1' }).success).toBe(false);
  });
});
