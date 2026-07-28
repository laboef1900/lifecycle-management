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

  it('treats an in-range-looking but out-of-spec window as disabled, not clamped', () => {
    // The 1..11 dead zone and anything past the max. The schema rejects these on
    // write, so reaching here means a direct DB write bypassed it — and on a
    // DESTRUCTIVE operation the safe answer is to prune nothing rather than to
    // invent a window nobody configured. Clamping (to 12, or to 120) would turn
    // a tampered value into real, unrecoverable deletes.
    for (const months of [1, 5, 11]) {
      expect(retentionCutoffMonth(JULY_2026, months)).toBeNull();
    }
    expect(retentionCutoffMonth(JULY_2026, 121)).toBeNull();
    expect(retentionCutoffMonth(JULY_2026, 10_000)).toBeNull();
  });

  it('accepts both ends of the permitted range', () => {
    // Guards the boundary the check above must not overshoot.
    expect(retentionCutoffMonth(JULY_2026, 12)).not.toBeNull();
    expect(retentionCutoffMonth(JULY_2026, 120)).not.toBeNull();
  });

  it('gives the same cutoff for a mid-month "now" as for a normalized one', () => {
    // The sweep passes a real `new Date()`; the read passes an already-normalized
    // month. Both must land on the same cutoff or the sweep could outrun the read.
    //
    // Characterization, NOT a regression guard for a fix: the function only ever
    // read year and month off this argument and hardcoded day 1, so it already
    // normalized implicitly — this passes under the pre-`startOfUtcMonth`
    // arithmetic too. It is here to pin the property against a future rewrite
    // (e.g. one reaching for `.getTime()`), not because it was ever broken.
    const midMonth = retentionCutoffMonth(new Date(Date.UTC(2026, 6, 17, 23, 59)), 12);
    expect(midMonth).toEqual(retentionCutoffMonth(JULY_2026, 12));
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
