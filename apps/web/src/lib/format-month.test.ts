import { describe, expect, it } from 'vitest';

import { formatMonthLong, formatMonthShort } from './format-month';

describe('formatMonthShort', () => {
  it('formats an ISO month-start date as "Mon YY" in UTC', () => {
    expect(formatMonthShort('2026-05-01')).toBe('May 26');
  });

  it('uses UTC even near month boundaries (no off-by-one)', () => {
    expect(formatMonthShort('2026-01-01')).toBe('Jan 26');
    expect(formatMonthShort('2026-12-01')).toBe('Dec 26');
  });
});

describe('formatMonthLong', () => {
  it('formats an ISO month-start date as "Month YYYY" in UTC', () => {
    expect(formatMonthLong('2026-05-01')).toBe('May 2026');
  });
});
