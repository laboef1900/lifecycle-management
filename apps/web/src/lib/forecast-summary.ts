import type { ForecastMonthPoint } from '@lcm/shared';

export const WARN_THRESHOLD = 0.7;
export const CRIT_THRESHOLD = 0.9;

export interface RunwaySummary {
  /** Index of first month at or above WARN_THRESHOLD, else null. */
  months: number | null;
  /** 'warn' | 'crit' when months === 0 (the breach is the current month); false otherwise. */
  alreadyBreached: 'warn' | 'crit' | false;
}

const NO_BREACH: RunwaySummary = Object.freeze({
  months: null,
  alreadyBreached: false,
}) as RunwaySummary;

export function runwayToWarn(points: ForecastMonthPoint[]): RunwaySummary {
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.capacity <= 0) continue;
    // Recompute rather than trusting p.utilization to avoid any server-side rounding skew.
    const u = p.consumption / p.capacity;
    if (u >= WARN_THRESHOLD) {
      const breached = i === 0 ? (u >= CRIT_THRESHOLD ? 'crit' : 'warn') : false;
      return { months: i, alreadyBreached: breached };
    }
  }
  return NO_BREACH;
}

/**
 * Aggregates per-month consumption and capacity across the supplied series,
 * then applies {@link runwayToWarn} to the merged sequence.
 *
 * Months that appear in some series but not others are aggregated using only
 * the data available — partial coverage is treated as "fleet utilization for
 * the clusters reporting that month". Callers that need apples-to-apples
 * comparison across the horizon must pre-align the series themselves.
 */
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

export type UtilStatus = 'ok' | 'warn' | 'crit';

/** Maps a utilization ratio (0..1) to the KpiTile status band. */
export function utilStatus(utilization: number): UtilStatus {
  if (utilization >= CRIT_THRESHOLD) return 'crit';
  if (utilization >= WARN_THRESHOLD) return 'warn';
  return 'ok';
}
