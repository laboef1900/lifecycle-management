/** Format a Date as its UTC calendar date, `YYYY-MM-DD`. */
export function formatDateIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const SHORT_FMT: Intl.DateTimeFormatOptions = { month: 'short', year: '2-digit', timeZone: 'UTC' };
const LONG_FMT: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric', timeZone: 'UTC' };

/** `'2026-06-01'` → `'Jun 26'` */
export function formatMonthShort(month: string): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', SHORT_FMT);
}

/** `'2026-06-01'` → `'June 2026'` */
export function formatMonthLong(month: string): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', LONG_FMT);
}

/**
 * Add calendar months in UTC, clamping the day-of-month to the target month's
 * length (Jan 31 + 1mo = Feb 28/29). Time-of-day is preserved.
 */
export function addUtcMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const daysInMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, daysInMonth));
  return result;
}
