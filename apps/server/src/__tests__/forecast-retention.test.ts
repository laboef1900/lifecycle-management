import { describe, expect, it } from 'vitest';

import { retentionCutoffMonth } from '../lib/forecast-retention.js';

const JULY_2026 = new Date(Date.UTC(2026, 6, 1));

describe('retentionCutoffMonth (#318)', () => {
  it('returns null when retention is disabled — nothing is bounded', () => {
    expect(retentionCutoffMonth(JULY_2026, 0)).toBeNull();
  });

  it('treats a negative window as disabled rather than as a future cutoff', () => {
    // Defence in depth: the schema rejects negatives, but a direct DB write
    // could store one. Failing to "keep everything" is the safe direction — the
    // alternative computes a cutoff in the FUTURE and would prune the lot.
    expect(retentionCutoffMonth(JULY_2026, -6)).toBeNull();
  });

  it('includes the current month in the window', () => {
    // 12 months at 2026-07 retains 2025-08..2026-07 inclusive.
    expect(retentionCutoffMonth(JULY_2026, 12)).toEqual(new Date(Date.UTC(2025, 7, 1)));
  });

  it('keeps only the current month at the degenerate window of 1', () => {
    expect(retentionCutoffMonth(JULY_2026, 1)).toEqual(JULY_2026);
  });

  it('crosses year boundaries', () => {
    expect(retentionCutoffMonth(JULY_2026, 36)).toEqual(new Date(Date.UTC(2023, 7, 1)));
    expect(retentionCutoffMonth(JULY_2026, 120)).toEqual(new Date(Date.UTC(2016, 7, 1)));
  });

  it('always lands on a first-of-month UTC date', () => {
    for (const months of [12, 13, 24, 37, 120]) {
      const cutoff = retentionCutoffMonth(new Date(Date.UTC(2026, 6, 17)), months);
      expect(cutoff?.getUTCDate()).toBe(1);
      expect(cutoff?.getUTCHours()).toBe(0);
    }
  });
});
