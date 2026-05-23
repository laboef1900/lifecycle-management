import type { ClusterResponse, ForecastMonthPoint, ForecastResponse } from '@lcm/shared';

export interface FleetSummary {
  totalConsumption: number;
  totalCapacity: number;
  utilization: number;
  clusterCount: number;
  worstCluster: { id: string; name: string; utilization: number } | null;
  perClusterSeries: Array<{
    clusterId: string;
    clusterName: string;
    months: ForecastMonthPoint[];
  }>;
  fleetMonths: Array<{
    month: string;
    capacityTotal: number;
    [clusterId: string]: number | string;
  }>;
}

interface ForecastEntry {
  clusterId: string;
  data: ForecastResponse | undefined;
}

export function aggregateFleet(
  clusters: ClusterResponse[],
  forecasts: ForecastEntry[],
): FleetSummary {
  if (clusters.length === 0) {
    return {
      totalConsumption: 0,
      totalCapacity: 0,
      utilization: 0,
      clusterCount: 0,
      worstCluster: null,
      perClusterSeries: [],
      fleetMonths: [],
    };
  }

  const forecastMap = new Map(forecasts.map((f) => [f.clusterId, f.data]));

  const sortedClusters = [...clusters].sort((a, b) => a.id.localeCompare(b.id));
  const perClusterSeries = sortedClusters.map((c) => ({
    clusterId: c.id,
    clusterName: c.name,
    months: forecastMap.get(c.id)?.months ?? [],
  }));

  const monthSet = new Set<string>();
  for (const series of perClusterSeries) {
    for (const point of series.months) {
      monthSet.add(point.month);
    }
  }
  const months = Array.from(monthSet).sort();

  const fleetMonths = months.map((month) => {
    const row: { month: string; capacityTotal: number; [clusterId: string]: number | string } = {
      month,
      capacityTotal: 0,
    };
    for (const series of perClusterSeries) {
      const point = series.months.find((p) => p.month === month);
      row[series.clusterId] = point?.consumption ?? 0;
      row.capacityTotal += point?.capacity ?? 0;
    }
    return row;
  });

  const latest = fleetMonths[fleetMonths.length - 1];
  let totalConsumption = 0;
  let totalCapacity = 0;
  if (latest) {
    for (const series of perClusterSeries) {
      const v = latest[series.clusterId];
      if (typeof v === 'number') totalConsumption += v;
    }
    totalCapacity = latest.capacityTotal;
  }
  const utilization = totalCapacity > 0 ? totalConsumption / totalCapacity : 0;

  let worstCluster: FleetSummary['worstCluster'] = null;
  for (const series of perClusterSeries) {
    const last = series.months[series.months.length - 1];
    if (!last) continue;
    const u = last.capacity > 0 ? last.consumption / last.capacity : 0;
    if (!worstCluster || u > worstCluster.utilization) {
      worstCluster = { id: series.clusterId, name: series.clusterName, utilization: u };
    }
  }

  return {
    totalConsumption,
    totalCapacity,
    utilization,
    clusterCount: clusters.length,
    worstCluster,
    perClusterSeries,
    fleetMonths,
  };
}
