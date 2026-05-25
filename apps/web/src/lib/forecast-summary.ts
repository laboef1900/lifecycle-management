import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { SYSTEM_DEFAULTS } from '@lcm/shared';

export const WARN_THRESHOLD = SYSTEM_DEFAULTS.warn;
export const CRIT_THRESHOLD = SYSTEM_DEFAULTS.crit;

export interface RunwaySummary {
  /** Index of first month at or above the warn threshold, else null. */
  months: number | null;
  /** 'warn' | 'crit' when months === 0 (the breach is the current month); false otherwise. */
  alreadyBreached: 'warn' | 'crit' | false;
}

const NO_BREACH: RunwaySummary = Object.freeze({
  months: null,
  alreadyBreached: false,
}) as RunwaySummary;

export function runwayToWarn(
  points: ForecastMonthPoint[],
  thresholds: { warn: number; crit: number } = SYSTEM_DEFAULTS,
): RunwaySummary {
  const { warn, crit } = thresholds;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.capacity <= 0) continue;
    const u = p.consumption / p.capacity;
    if (u >= warn) {
      const breached = i === 0 ? (u >= crit ? 'crit' : 'warn') : false;
      return { months: i, alreadyBreached: breached };
    }
  }
  return NO_BREACH;
}

export function fleetRunwayToWarn(
  series: ForecastMonthPoint[][],
  thresholds: { warn: number; crit: number } = SYSTEM_DEFAULTS,
): RunwaySummary {
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
  return runwayToWarn(merged, thresholds);
}

export type UtilStatus = 'ok' | 'warn' | 'crit';

export function utilStatus(
  utilization: number,
  thresholds: { warn: number; crit: number } = SYSTEM_DEFAULTS,
): UtilStatus {
  if (utilization >= thresholds.crit) return 'crit';
  if (utilization >= thresholds.warn) return 'warn';
  return 'ok';
}

export type KpiStatus = UtilStatus | 'attention';

export interface ClusterForecastEntry {
  cluster: ClusterResponse;
  months: ForecastMonthPoint[];
  thresholds: { warn: number; crit: number };
  summary: RunwaySummary;
}

export interface ClusterForecastSource {
  months: ForecastMonthPoint[];
  thresholds: { warn: number; crit: number };
}

export function buildClusterForecastEntries(
  clusters: ClusterResponse[],
  forecastsById: Record<string, ClusterForecastSource | undefined>,
): ClusterForecastEntry[] {
  const entries: ClusterForecastEntry[] = [];
  for (const cluster of clusters) {
    const source = forecastsById[cluster.id];
    if (!source) continue;
    entries.push({
      cluster,
      months: source.months,
      thresholds: source.thresholds,
      summary: runwayToWarn(source.months, source.thresholds),
    });
  }
  return entries;
}
