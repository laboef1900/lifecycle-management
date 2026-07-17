import { describe, expect, it } from 'vitest';

import { STALE_BASELINE_DAYS, baselineAgeDays, isBaselineStale } from './stale-baseline';

describe('STALE_BASELINE_DAYS', () => {
  it('is 90 days', () => {
    expect(STALE_BASELINE_DAYS).toBe(90);
  });
});

describe('baselineAgeDays', () => {
  it('counts whole days between the baseline date and today (UTC calendar days)', () => {
    expect(baselineAgeDays('2026-03-10', new Date('2026-07-16'))).toBe(128);
  });

  it('is zero when the baseline was measured today', () => {
    expect(baselineAgeDays('2026-07-16', new Date('2026-07-16'))).toBe(0);
  });

  it('defaults `today` to the real current date when omitted', () => {
    const today = new Date();
    const iso = today.toISOString().slice(0, 10);
    expect(baselineAgeDays(iso)).toBe(0);
  });
});

describe('isBaselineStale', () => {
  it('is true past 90 days old', () => {
    expect(isBaselineStale('2026-03-10', new Date('2026-07-16'))).toBe(true);
  });

  it('is false for a fresh baseline', () => {
    expect(isBaselineStale('2026-06-20', new Date('2026-07-16'))).toBe(false);
  });

  it('is false exactly at the 90-day boundary (strictly greater-than triggers staleness)', () => {
    expect(isBaselineStale('2026-04-17', new Date('2026-07-16'))).toBe(false);
  });

  it('is true one day past the 90-day boundary', () => {
    expect(isBaselineStale('2026-04-16', new Date('2026-07-16'))).toBe(true);
  });
});
