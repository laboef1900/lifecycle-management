import { describe, expect, it } from 'vitest';

import { addUtcMonths, formatDateIso, formatMonthLong, formatMonthShort } from '../dates.js';

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
