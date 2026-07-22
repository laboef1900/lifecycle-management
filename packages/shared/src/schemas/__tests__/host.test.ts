import { describe, expect, it } from 'vitest';

import { hostMoveInputSchema } from '../host.js';

/**
 * The move contract (#289). `moveDate` is constrained to the first of a month
 * because the forecast resolves membership at first-of-month granularity; a
 * mid-month date is silently coarse and two moves in one calendar month would
 * permanently strand the intermediate cluster (review finding). Pinning the
 * constraint at the contract boundary is what makes that sequence impossible.
 */
describe('hostMoveInputSchema — first-of-month moveDate (#289)', () => {
  it('accepts a first-of-month moveDate and transforms it to a UTC Date', () => {
    const parsed = hostMoveInputSchema.parse({ clusterId: 'c1', moveDate: '2026-06-01' });
    expect(parsed.moveDate.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('rejects a mid-month moveDate — the engine cannot represent it', () => {
    expect(hostMoveInputSchema.safeParse({ clusterId: 'c1', moveDate: '2026-06-15' }).success).toBe(
      false,
    );
    expect(hostMoveInputSchema.safeParse({ clusterId: 'c1', moveDate: '2026-06-30' }).success).toBe(
      false,
    );
  });

  it('rejects a malformed date and unknown keys (strict)', () => {
    expect(hostMoveInputSchema.safeParse({ clusterId: 'c1', moveDate: '2026-06' }).success).toBe(
      false,
    );
    expect(
      hostMoveInputSchema.safeParse({ clusterId: 'c1', moveDate: '2026-06-01', extra: true })
        .success,
    ).toBe(false);
  });
});
