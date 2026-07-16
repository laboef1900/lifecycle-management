/**
 * Forecast reliability degrades once a cluster's memory baseline has not been
 * re-measured in a while — 90 days matches the mockup's demo constant and is
 * the durable threshold for this app (spec §4.4 "stale-baseline warnings").
 */
export const STALE_BASELINE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole UTC calendar days between `baselineDate` (`YYYY-MM-DD`) and `today`. */
export function baselineAgeDays(baselineDate: string, today: Date = new Date()): number {
  const baseline = new Date(`${baselineDate}T00:00:00Z`).getTime();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((todayUtc - baseline) / DAY_MS);
}

/** True once a baseline is more than {@link STALE_BASELINE_DAYS} old. */
export function isBaselineStale(baselineDate: string, today: Date = new Date()): boolean {
  return baselineAgeDays(baselineDate, today) > STALE_BASELINE_DAYS;
}
