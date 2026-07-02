import { describe, expect, it } from 'vitest';
import { clustersListQuerySchema } from '../cluster.js';

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
