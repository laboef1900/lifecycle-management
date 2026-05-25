import type { ClusterResponse, ForecastMonthPoint, ForecastResponse } from '@lcm/shared';

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
  let forecastsLoading = false;
  let responsiveCount = 0;

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i]!;
    const q = queries[i];
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
    }

    if (q?.isError && q.error !== undefined && q.error !== null) {
      errorsById[cluster.id] =
        q.error instanceof Error ? q.error.message : 'Failed to load forecast';
    }

    if (q?.isPending) forecastsLoading = true;
    if (q?.isSuccess) responsiveCount++;
  }

  const summary = aggregateFleet(clusters, forecastEntries);

  return { summary, forecastsById, errorsById, forecastsLoading, responsiveCount };
}
