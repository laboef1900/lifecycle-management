import { describe, expect, it } from 'vitest';

import {
  addUtcMonths,
  formatDateIso,
  formatMonthLong,
  formatMonthShort,
  isSupportedDate,
  shiftDateByUnit,
} from '../dates.js';

describe('formatDateIso', () => {
  it('formats a UTC date as YYYY-MM-DD', () => {
    expect(formatDateIso(new Date('2026-06-10T15:30:00Z'))).toBe('2026-06-10');
  });
});

describe('formatMonthShort / formatMonthLong', () => {
  it('formats an ISO month string', () => {
    expect(formatMonthShort('2026-06-01')).toBe('Jun 26');
    expect(formatMonthLong('2026-06-01')).toBe('June 2026');
  });
});

describe('addUtcMonths', () => {
  it('adds months within a year', () => {
    expect(addUtcMonths(new Date('2026-09-01T00:00:00Z'), 2).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
  });

  it('rolls over year boundaries', () => {
    expect(addUtcMonths(new Date('2026-11-15T00:00:00Z'), 3).toISOString()).toBe(
      '2027-02-15T00:00:00.000Z',
    );
  });

  it('clamps to the last day of shorter months', () => {
    expect(addUtcMonths(new Date('2026-08-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-09-30T00:00:00.000Z',
    );
    expect(addUtcMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  it('handles leap years', () => {
    expect(addUtcMonths(new Date('2028-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('preserves time-of-day', () => {
    expect(addUtcMonths(new Date('2026-03-10T12:34:56.789Z'), 1).toISOString()).toBe(
      '2026-04-10T12:34:56.789Z',
    );
  });

  it('supports negative offsets', () => {
    expect(addUtcMonths(new Date('2026-03-31T00:00:00Z'), -1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  it('returns an equal date for a zero offset', () => {
    expect(addUtcMonths(new Date('2026-06-10T08:00:00Z'), 0).toISOString()).toBe(
      '2026-06-10T08:00:00.000Z',
    );
  });

  it('supports multi-month negative offsets with clamping', () => {
    expect(addUtcMonths(new Date('2026-05-31T00:00:00Z'), -3).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });
});

describe('shiftDateByUnit', () => {
  const at = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
  const shifted = (iso: string, amount: number, unit: 'days' | 'weeks' | 'months'): string =>
    formatDateIso(shiftDateByUnit(at(iso), amount, unit));

  it('moves forwards and backwards in days and weeks', () => {
    expect(shifted('2026-03-01', 10, 'days')).toBe('2026-03-11');
    expect(shifted('2026-03-01', -10, 'days')).toBe('2026-02-19');
    expect(shifted('2026-03-01', 2, 'weeks')).toBe('2026-03-15');
    expect(shifted('2026-03-01', -2, 'weeks')).toBe('2026-02-15');
  });

  it('crosses year boundaries', () => {
    expect(shifted('2026-01-15', -1, 'months')).toBe('2025-12-15');
    expect(shifted('2026-12-15', 1, 'months')).toBe('2027-01-15');
  });

  it('clamps the day of month, which can collapse two dates onto one', () => {
    expect(shifted('2026-01-31', 1, 'months')).toBe('2026-02-28');
    expect(shifted('2026-01-29', 1, 'months')).toBe('2026-02-28');
    // Leap year: February has a 29th, so the same shift lands elsewhere.
    expect(shifted('2028-01-31', 1, 'months')).toBe('2028-02-29');
  });

  it('is monotone — order is never inverted by a uniform shift', () => {
    const earlier = shiftDateByUnit(at('2026-01-01'), 1, 'months');
    const later = shiftDateByUnit(at('2026-02-01'), 1, 'months');
    expect(earlier.getTime()).toBeLessThan(later.getTime());
  });
});

describe('isSupportedDate', () => {
  it('accepts dates inside the persistable range', () => {
    expect(isSupportedDate(new Date('2026-06-10T00:00:00Z'))).toBe(true);
    expect(isSupportedDate(new Date('1970-01-01T00:00:00Z'))).toBe(true);
    expect(isSupportedDate(new Date('2999-12-31T00:00:00Z'))).toBe(true);
  });

  it('rejects dates outside it, and invalid dates', () => {
    expect(isSupportedDate(new Date('1969-12-31T00:00:00Z'))).toBe(false);
    expect(isSupportedDate(new Date('3000-01-01T00:00:00Z'))).toBe(false);
    expect(isSupportedDate(new Date('not a date'))).toBe(false);
  });
});
