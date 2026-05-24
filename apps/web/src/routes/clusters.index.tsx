import type { ForecastMonthPoint, ForecastResponse } from '@lcm/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';

import { ClusterTable } from '@/components/clusters/cluster-table';
import { CreateClusterDialog } from '@/components/clusters/create-cluster-dialog';
import { ClustersEmptyState } from '@/components/clusters/empty-state';
import { resolveWindow } from '@/components/clusters/window-controls';
import { KpiTile } from '@/components/overview/kpi-tile';
import { Card } from '@/components/ui/card';
import { aggregateFleet } from '@/lib/aggregate-fleet';
import { type UtilStatus, fleetRunwayToWarn, utilStatus } from '@/lib/forecast-summary';
import { api } from '@/lib/api-client';

export const Route = createFileRoute('/clusters/')({
  component: ClustersPage,
});

function ClustersPage(): React.JSX.Element {
  const clustersQuery = useQuery({
    queryKey: ['clusters'],
    queryFn: () => api.clusters.list(),
  });

  const clusters = clustersQuery.data ?? [];

  const forecastQueries = useQueries({
    queries: clusters.map((cluster) => {
      const metric = cluster.metrics[0];
      const range = resolveWindow('24mo', cluster.baselineDate);
      return {
        queryKey: ['forecast', cluster.id, metric?.metricTypeKey, range.from, range.to],
        queryFn: () =>
          api.clusters.forecast(cluster.id, {
            metric: metric!.metricTypeKey,
            from: range.from,
            to: range.to,
          }),
        enabled: Boolean(metric),
      };
    }),
  });

  const forecastEntries = clusters.map((c, i) => ({
    clusterId: c.id,
    data: forecastQueries[i]?.data as ForecastResponse | undefined,
  }));
  const forecastsById: Record<string, ForecastMonthPoint[]> = {};
  let horizonMonths = 0;
  clusters.forEach((cluster, i) => {
    const data = forecastQueries[i]?.data as ForecastResponse | undefined;
    if (data) {
      forecastsById[cluster.id] = data.months;
      horizonMonths = Math.max(horizonMonths, data.months.length);
    }
  });

  const fleetSummary = aggregateFleet(clusters, forecastEntries);
  const fleetRunway = fleetRunwayToWarn(fleetSummary.perClusterSeries.map((s) => s.months));
  const numberFormat = new Intl.NumberFormat('en-US');
  const headroom = Math.max(0, fleetSummary.totalCapacity - fleetSummary.totalConsumption);

  let runwayKpiValue: string;
  let runwayKpiStatus: UtilStatus;
  if (fleetRunway.alreadyBreached === 'crit') {
    runwayKpiValue = 'Over 90%';
    runwayKpiStatus = 'crit';
  } else if (fleetRunway.alreadyBreached === 'warn') {
    runwayKpiValue = 'Over 70%';
    runwayKpiStatus = 'warn';
  } else if (fleetRunway.months === null) {
    runwayKpiValue = horizonMonths > 0 ? `${horizonMonths}+ mo` : '—';
    runwayKpiStatus = 'ok';
  } else {
    runwayKpiValue = `${fleetRunway.months} mo to 70%`;
    runwayKpiStatus = fleetRunway.months < 3 ? 'crit' : fleetRunway.months < 12 ? 'warn' : 'ok';
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Capacity Forecast
          </p>
          <h1 className="mt-1 text-[26px] font-semibold leading-[1.1] tracking-[-0.02em]">
            Clusters
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {clustersQuery.data?.length
              ? `${clustersQuery.data.length} clusters tracked`
              : 'Capacity forecasts across all tracked clusters.'}
          </p>
        </header>
        {clustersQuery.data && clustersQuery.data.length > 0 ? <CreateClusterDialog /> : null}
      </div>

      {clustersQuery.isPending ? <ClusterTableSkeleton /> : null}

      {clustersQuery.isError ? (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Could not load clusters: {clustersQuery.error.message}</span>
        </Card>
      ) : null}

      {clustersQuery.data?.length === 0 ? <ClustersEmptyState /> : null}

      {clusters.length > 0 ? (
        <div className="grid grid-cols-12 gap-4">
          <KpiTile
            className="col-span-12 sm:col-span-4"
            label="Used"
            value={`${numberFormat.format(Math.round(fleetSummary.totalConsumption))} GB`}
            caption={`of ${numberFormat.format(Math.round(fleetSummary.totalCapacity))} GB capacity`}
            status={utilStatus(fleetSummary.utilization)}
          />
          <KpiTile
            className="col-span-12 sm:col-span-4"
            label="Headroom"
            value={`${numberFormat.format(Math.round(headroom))} GB`}
            caption={`${((1 - fleetSummary.utilization) * 100).toFixed(1)}% available`}
            status={utilStatus(fleetSummary.utilization)}
          />
          <KpiTile
            className="col-span-12 sm:col-span-4"
            label="Fleet runway"
            value={runwayKpiValue}
            caption={
              fleetSummary.worstCluster
                ? `limited by ${fleetSummary.worstCluster.name}`
                : 'fleet projection'
            }
            status={runwayKpiStatus}
          />
        </div>
      ) : null}

      {clusters.length > 0 ? (
        <ClusterTable
          clusters={clusters}
          forecastsById={forecastsById}
          {...(horizonMonths > 0 && { horizonMonths })}
        />
      ) : null}
    </div>
  );
}

function ClusterTableSkeleton(): React.JSX.Element {
  return (
    <Card className="p-4">
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded bg-muted" />
        ))}
      </div>
    </Card>
  );
}
