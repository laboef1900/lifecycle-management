import type { ForecastResponse } from '@lcm/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';

import { ClusterTile } from '@/components/overview/cluster-tile';
import { FleetCapacityChart } from '@/components/overview/fleet-capacity-chart';
import { KpiTile } from '@/components/overview/kpi-tile';
import { Card } from '@/components/ui/card';
import { aggregateFleet } from '@/lib/aggregate-fleet';
import { api } from '@/lib/api-client';

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
      const range = computeWindow(cluster.baselineDate, 24);
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
            status={
              summary.utilization >= 0.9 ? 'crit' : summary.utilization >= 0.7 ? 'warn' : 'ok'
            }
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
            label="Worst cluster"
            value={summary.worstCluster?.name ?? '—'}
            caption={
              summary.worstCluster
                ? `${(summary.worstCluster.utilization * 100).toFixed(1)}% utilization`
                : 'no data'
            }
            status={
              summary.worstCluster && summary.worstCluster.utilization >= 0.9
                ? 'crit'
                : summary.worstCluster && summary.worstCluster.utilization >= 0.7
                  ? 'warn'
                  : 'ok'
            }
          />

          <Card className="col-span-12 p-4">
            <FleetCapacityChart
              fleetMonths={summary.fleetMonths}
              clusters={summary.perClusterSeries.map((s) => ({
                clusterId: s.clusterId,
                clusterName: s.clusterName,
              }))}
            />
          </Card>

          {summary.perClusterSeries.map((series) => {
            const cluster = clusters.find((c) => c.id === series.clusterId);
            if (!cluster) return null;
            const trend = series.months.slice(-12).map((m) => m.consumption);
            const ceiling = series.months.slice(-12).map((m) => m.capacity);
            return (
              <ClusterTile
                key={series.clusterId}
                className="col-span-12 md:col-span-6"
                cluster={cluster}
                trend={trend}
                trendCeiling={ceiling}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function computeWindow(baselineDate: string, months: number): { from: string; to: string } {
  const baseline = new Date(`${baselineDate}T00:00:00Z`);
  const half = Math.floor(months / 2);
  const from = new Date(baseline);
  from.setUTCMonth(from.getUTCMonth() - half);
  const to = new Date(baseline);
  to.setUTCMonth(to.getUTCMonth() + (months - half));
  return {
    from: `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}-01`,
    to: `${to.getUTCFullYear()}-${String(to.getUTCMonth() + 1).padStart(2, '0')}-01`,
  };
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
