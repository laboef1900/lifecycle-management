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

/**
 * The first of `date`'s month at 00:00 UTC — the canonical **period anchor**.
 *
 * Every baseline's `capturedAt` is snapped through here, whether entered by hand
 * or captured by the monthly vSphere snapshot. That is what makes
 * `@@unique([clusterId, metricTypeId, capturedAt])` mean "one truth per month"
 * rather than "one truth per day": a snapshot job that restarts and re-runs on a
 * different day of the same month recomputes the same anchor and conflicts,
 * instead of appending a second competing baseline for that period.
 *
 * @ai-note Anchoring on day 1 also sidesteps `addUtcMonths`' day-clamping — any
 * other anchor would drift permanently to the 28th after one pass through
 * February.
 */
export function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** Whole-month difference between two UTC dates (to minus from). */
export function monthsBetweenUtc(from: Date, to: Date): number {
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
  );
}
