import type { ForecastMonthPoint } from '@lcm/shared';

export const WARN_THRESHOLD = 0.7;
export const CRIT_THRESHOLD = 0.9;

export interface RunwaySummary {
  /** Index of first month at or above WARN_THRESHOLD, else null. */
  months: number | null;
  /** First month's status when months === 0 (or false if no breach there). */
  alreadyBreached: 'warn' | 'crit' | false;
}

const NO_BREACH: RunwaySummary = { months: null, alreadyBreached: false };

export function runwayToWarn(months: ForecastMonthPoint[]): RunwaySummary {
  for (let i = 0; i < months.length; i++) {
    const m = months[i]!;
    if (m.capacity <= 0) continue;
    const u = m.consumption / m.capacity;
    if (u >= WARN_THRESHOLD) {
      const breached = i === 0 ? (u >= CRIT_THRESHOLD ? 'crit' : 'warn') : false;
      return { months: i, alreadyBreached: breached };
    }
  }
  return NO_BREACH;
}

export function fleetRunwayToWarn(series: ForecastMonthPoint[][]): RunwaySummary {
  if (series.length === 0) return NO_BREACH;
  const byMonth = new Map<string, { consumption: number; capacity: number }>();
  for (const points of series) {
    for (const p of points) {
      const agg = byMonth.get(p.month) ?? { consumption: 0, capacity: 0 };
      agg.consumption += p.consumption;
      agg.capacity += p.capacity;
      byMonth.set(p.month, agg);
    }
  }
  const merged: ForecastMonthPoint[] = Array.from(byMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, agg]) => ({
      month,
      consumption: agg.consumption,
      capacity: agg.capacity,
      utilization: agg.capacity > 0 ? agg.consumption / agg.capacity : 0,
    }));
  return runwayToWarn(merged);
}
