import { describe, expect, it } from 'vitest';

import { daysUntil } from './dates';

describe('daysUntil', () => {
  it('returns 0 when the date is today', () => {
    expect(daysUntil('2026-05-25', new Date('2026-05-25T12:00:00Z'))).toBe(0);
  });

  it('returns a positive count for a future date', () => {
    expect(daysUntil('2026-06-10', new Date('2026-05-25T12:00:00Z'))).toBe(16);
  });

  it('returns a negative count for a past date', () => {
    expect(daysUntil('2026-04-01', new Date('2026-05-25T12:00:00Z'))).toBe(-54);
  });

  it('ignores the time-of-day component of `today` (whole UTC calendar days)', () => {
    expect(daysUntil('2026-05-26', new Date('2026-05-25T23:59:59Z'))).toBe(1);
    expect(daysUntil('2026-05-26', new Date('2026-05-25T00:00:00Z'))).toBe(1);
  });

  it('defaults `today` to the current date when omitted', () => {
    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    expect(daysUntil(todayIso)).toBe(0);
  });
});
