import type { ForecastResponse } from '@lcm/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';

import { resolveWindow } from '@/components/clusters/window-controls';
import { ClusterTile } from '@/components/overview/cluster-tile';
import { FleetCapacityChart } from '@/components/overview/fleet-capacity-chart';
import { KpiTile } from '@/components/overview/kpi-tile';
import { Card } from '@/components/ui/card';
import { aggregateFleet } from '@/lib/aggregate-fleet';
import { api } from '@/lib/api-client';
import { type KpiStatus, fleetRunwayToWarn, utilStatus } from '@/lib/forecast-summary';
import { useMediaQuery } from '@/lib/use-media-query';

export const Route = createFileRoute('/')({
  component: OverviewPage,
});

function OverviewPage(): React.JSX.Element {
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

  const summary = aggregateFleet(clusters, forecastEntries);
  const isWide = useMediaQuery('(min-width: 640px)');

  const fleetRunway = fleetRunwayToWarn(summary.perClusterSeries.map((s) => s.months));
  const horizonMonths = Math.max(0, ...summary.perClusterSeries.map((s) => s.months.length));

  let runwayValue: string;
  let runwayCaption: string;
  let runwayStatus: KpiStatus;
  if (fleetRunway.alreadyBreached === 'crit') {
    runwayValue = 'Over 90%';
    runwayCaption = 'fleet has breached crit';
    runwayStatus = 'crit';
  } else if (fleetRunway.alreadyBreached === 'warn') {
    runwayValue = 'Over 70%';
    runwayCaption = 'fleet has breached warn';
    runwayStatus = 'warn';
  } else if (fleetRunway.months === null) {
    runwayValue = horizonMonths > 0 ? `${horizonMonths}+ mo` : '—';
    runwayCaption = 'no projected breach';
    runwayStatus = 'attention';
  } else {
    runwayValue = `${fleetRunway.months} mo to 70%`;
    runwayCaption = summary.worstCluster
      ? `limited by ${summary.worstCluster.name}`
      : 'fleet projection';
    runwayStatus = fleetRunway.months < 3 ? 'crit' : fleetRunway.months < 12 ? 'warn' : 'ok';
  }

  const isLoading = clustersQuery.isPending;
  const isError = clustersQuery.isError;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Overview
        </p>
        <h1 className="text-[1.625rem] font-semibold tracking-tight">Fleet</h1>
      </header>

      {isLoading ? <OverviewSkeleton /> : null}

      {isError ? (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Could not load clusters: {clustersQuery.error?.message}</span>
        </Card>
      ) : null}

      {!isLoading && !isError && clusters.length === 0 ? (
        <Card className="border-dashed p-8 text-center text-sm text-muted-foreground">
          No clusters yet. Add one from the Clusters page to see fleet overview.
        </Card>
      ) : null}

      {!isLoading && !isError && clusters.length > 0 ? (
        <div className="grid grid-cols-12 gap-4">
          <KpiTile
            className="col-span-12 sm:col-span-4"
            label="Fleet utilization"
            value={`${(summary.utilization * 100).toFixed(1)}%`}
            caption="memory used"
            status={utilStatus(summary.utilization)}
          />
          <KpiTile
            className="col-span-12 sm:col-span-4"
            label="Clusters tracked"
            value={String(summary.clusterCount)}
            caption={`${forecastQueries.filter((q) => q.isSuccess).length} responsive`}
            status="ok"
          />
          <KpiTile
            className="col-span-12 sm:col-span-4"
            label="Fleet runway"
            value={runwayValue}
            caption={runwayCaption}
            status={runwayStatus}
          />

          <Card className="col-span-12 p-4">
            <FleetCapacityChart
              fleetMonths={summary.fleetMonths}
              clusters={summary.perClusterSeries.map((s) => ({
                clusterId: s.clusterId,
                clusterName: s.clusterName,
              }))}
              compact={!isWide}
            />
          </Card>

          {summary.perClusterSeries.map((series) => {
            const cluster = clusters.find((c) => c.id === series.clusterId);
            if (!cluster) return null;
            return (
              <ClusterTile
                key={series.clusterId}
                className="col-span-12 md:col-span-6"
                cluster={cluster}
                forecastMonths={series.months}
                horizonMonths={series.months.length}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function OverviewSkeleton(): React.JSX.Element {
  return (
    <div className="grid grid-cols-12 gap-4">
      <Card className="col-span-12 h-24 animate-pulse sm:col-span-4" />
      <Card className="col-span-12 h-24 animate-pulse sm:col-span-4" />
      <Card className="col-span-12 h-24 animate-pulse sm:col-span-4" />
      <Card className="col-span-12 h-[320px] animate-pulse" />
      <Card className="col-span-12 h-32 animate-pulse md:col-span-6" />
      <Card className="col-span-12 h-32 animate-pulse md:col-span-6" />
    </div>
  );
}
