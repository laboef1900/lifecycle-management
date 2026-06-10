import type {
  ClusterResponse,
  ForecastMonthPoint,
  ForecastResponse,
  ProcurementInfo,
} from '@lcm/shared';

import { aggregateFleet, type FleetSummary } from './aggregate-fleet';
import type { ClusterForecastSource } from './forecast-summary';

export interface ForecastQueryLike {
  data: ForecastResponse | undefined;
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: unknown;
}

export interface ForecastState {
  summary: FleetSummary;
  forecastsById: Record<string, ClusterForecastSource>;
  errorsById: Record<string, string | undefined>;
  procurementByClusterId: Record<string, ProcurementInfo>;
  forecastsLoading: boolean;
  responsiveCount: number;
}

export function collectForecastState(
  clusters: ClusterResponse[],
  queries: ForecastQueryLike[],
): ForecastState {
  const forecastEntries: Array<{ clusterId: string; data: ForecastResponse | undefined }> = [];
  const forecastsById: Record<string, ClusterForecastSource> = {};
  const errorsById: Record<string, string | undefined> = {};
  const procurementByClusterId: Record<string, ProcurementInfo> = {};
  let forecastsLoading = false;
  let responsiveCount = 0;

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i]!;
    const q = queries[i];

    if (cluster.metrics.length === 0) {
      forecastEntries.push({ clusterId: cluster.id, data: undefined });
      errorsById[cluster.id] = 'No metric configured';
      continue;
    }

    const data = q?.data;
    forecastEntries.push({ clusterId: cluster.id, data });

    if (data) {
      const months: ForecastMonthPoint[] = data.months;
      forecastsById[cluster.id] = {
        months,
        thresholds: {
          warn: data.effectiveThresholds.warn,
          crit: data.effectiveThresholds.crit,
        },
      };
      procurementByClusterId[cluster.id] = data.procurement;
    }

    if (q?.isError) {
      errorsById[cluster.id] =
        q.error instanceof Error ? q.error.message : 'Failed to load forecast';
    }

    if (q?.isPending) forecastsLoading = true;
    if (q?.isSuccess) responsiveCount++;
  }

  const summary = aggregateFleet(clusters, forecastEntries);

  return {
    summary,
    forecastsById,
    errorsById,
    procurementByClusterId,
    forecastsLoading,
    responsiveCount,
  };
}

/**
 * Pick the cluster whose `orderByDate` is earliest (= most urgent procurement
 * deadline across the fleet). Clusters with no projected breach are skipped.
 */
export function earliestOrderByFromFleet(
  clusters: ClusterResponse[],
  procurementByClusterId: Record<string, ProcurementInfo>,
): { cluster: ClusterResponse; procurement: ProcurementInfo } | null {
  let best: { cluster: ClusterResponse; procurement: ProcurementInfo } | null = null;
  for (const cluster of clusters) {
    const info = procurementByClusterId[cluster.id];
    if (!info || info.orderByDate === null) continue;
    if (!best || info.orderByDate < best.procurement.orderByDate!) {
      best = { cluster, procurement: info };
    }
  }
  return best;
}
