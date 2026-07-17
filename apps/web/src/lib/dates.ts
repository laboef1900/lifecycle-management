const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days from `today` (UTC midnight) until `dateIso` (also UTC midnight, parsed
 * as `YYYY-MM-DD`). Negative when `dateIso` is in the past. Single source of
 * truth for this whole-calendar-day math — previously duplicated verbatim in
 * `procurement-kpi.ts` and `order-by-rail.tsx`, which both consume it so
 * their urgency thresholds never drift apart.
 */
export function daysUntil(dateIso: string, today: Date = new Date()): number {
  const target = new Date(`${dateIso}T00:00:00Z`).getTime();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target - todayUtc) / DAY_MS);
}
