import { daysUntil } from '@/lib/dates';

/**
 * Forecast reliability degrades once a cluster's memory baseline has not been
 * re-measured in a while — 90 days matches the mockup's demo constant and is
 * the durable threshold for this app (spec §4.4 "stale-baseline warnings").
 */
export const STALE_BASELINE_DAYS = 90;

/**
 * Whole UTC calendar days between `baselineDate` (`YYYY-MM-DD`) and `today`.
 * Reimplemented on the shared `daysUntil` (PR review fix 4b) instead of a
 * private duplicate of the same UTC-midnight day-math — `daysUntil` counts
 * from `today` to a future date (negative when in the past), so the age is
 * just its negation. `|| 0` normalizes the `-0` that plain negation produces
 * when the baseline is today (`-0 !== 0` under `Object.is`/`toBe`, even
 * though both print as "0" and compare `===` equal).
 */
export function baselineAgeDays(baselineDate: string, today: Date = new Date()): number {
  return -daysUntil(baselineDate, today) || 0;
}

/** True once a baseline is more than {@link STALE_BASELINE_DAYS} old. */
export function isBaselineStale(baselineDate: string, today: Date = new Date()): boolean {
  return baselineAgeDays(baselineDate, today) > STALE_BASELINE_DAYS;
}
