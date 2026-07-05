import { useQueries, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { resolveWindow } from '@/components/clusters/window-controls';
import { FleetClusterGrid } from '@/components/overview/fleet-cluster-grid';
import { FleetUtilizationHeatmap } from '@/components/overview/fleet-utilization-heatmap';
import { KpiTile } from '@/components/overview/kpi-tile';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { api } from '@/lib/api-client';
import { collectForecastState, earliestOrderByFromFleet } from '@/lib/collect-forecast-state';
import {
  type KpiStatus,
  buildClusterForecastEntries,
  fleetRunwayToWarn,
  utilStatus,
} from '@/lib/forecast-summary';
import { deriveProcurementKpi } from '@/lib/procurement-kpi';
import { useEffectiveThresholds } from '@/lib/use-effective-thresholds';

export const Route = createFileRoute('/_app/')({
  component: OverviewPage,
});

function OverviewPage(): React.JSX.Element {
  const clustersQuery = useQuery({
    queryKey: ['clusters'],
    queryFn: () => api.clusters.list(),
    select: (page) => page.items,
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

  const {
    summary,
    forecastsById,
    errorsById,
    procurementByClusterId,
    forecastsLoading,
    responsiveCount,
  } = collectForecastState(clusters, forecastQueries);
  const thresholds = useEffectiveThresholds();
  const clusterEntries = buildClusterForecastEntries(clusters, forecastsById, errorsById);
  const earliestOrderBy = earliestOrderByFromFleet(clusters, procurementByClusterId);
  const earliestKpi = earliestOrderBy
    ? deriveProcurementKpi(earliestOrderBy.procurement)
    : { value: '—', caption: 'no projected breach in fleet', status: 'ok' as const };
  const earliestCaption = earliestOrderBy
    ? `limited by ${earliestOrderBy.cluster.name}`
    : earliestKpi.caption;

  const fleetRunway = fleetRunwayToWarn(
    summary.perClusterSeries.map((s) => s.months),
    thresholds,
  );
  const horizonMonths = Math.max(0, ...summary.perClusterSeries.map((s) => s.months.length));

  const warnPct = Math.round(thresholds.warn * 100);
  const critPct = Math.round(thresholds.crit * 100);

  let runwayValue: string;
  let runwayCaption: string;
  let runwayStatus: KpiStatus;
  if (fleetRunway.alreadyBreached === 'crit') {
    runwayValue = `Over ${critPct}%`;
    runwayCaption = 'fleet has breached crit';
    runwayStatus = 'crit';
  } else if (fleetRunway.alreadyBreached === 'warn') {
    runwayValue = `Over ${warnPct}%`;
    runwayCaption = 'fleet has breached warn';
    runwayStatus = 'warn';
  } else if (fleetRunway.months === null) {
    runwayValue = horizonMonths > 0 ? `${horizonMonths}+ mo` : '—';
    runwayCaption = 'no projected breach';
    runwayStatus = 'attention';
  } else {
    runwayValue = `${fleetRunway.months} mo to ${warnPct}%`;
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
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
          Capacity Forecast
        </p>
        <h1 className="mt-1 text-[26px] font-semibold leading-[1.1] tracking-[-0.02em]">Fleet</h1>
      </header>

      {isLoading ? <OverviewSkeleton /> : null}

      {isError ? (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive shadow-none">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Could not load clusters: {clustersQuery.error?.message}</span>
        </Card>
      ) : null}

      {!isLoading && !isError && clusters.length === 0 ? (
        <EmptyState
          title="No clusters yet."
          description="Add one from the Clusters page to see fleet overview."
        />
      ) : null}

      {!isLoading && !isError && clusters.length > 0 ? (
        <div className="grid grid-cols-12 gap-2">
          <KpiTile
            className="col-span-12 sm:col-span-6 lg:col-span-3"
            label="Fleet utilization"
            value={`${(summary.utilization * 100).toFixed(1)}%`}
            caption="memory used"
            status={utilStatus(summary.utilization, thresholds)}
          />
          <KpiTile
            className="col-span-12 sm:col-span-6 lg:col-span-3"
            label="Clusters tracked"
            value={String(summary.clusterCount)}
            caption={`${responsiveCount} responsive`}
            status="ok"
          />
          <KpiTile
            className="col-span-12 sm:col-span-6 lg:col-span-3"
            label="Fleet runway"
            value={runwayValue}
            caption={runwayCaption}
            status={runwayStatus}
          />
          <KpiTile
            className="col-span-12 sm:col-span-6 lg:col-span-3"
            label="Earliest order-by"
            value={earliestKpi.value}
            caption={earliestCaption}
            status={earliestKpi.status}
          />

          <div className="col-span-12">
            <FleetClusterGrid
              entries={clusterEntries}
              isLoading={forecastsLoading}
              total={clusters.length}
            />
          </div>

          <div className="col-span-12">
            <FleetUtilizationHeatmap entries={clusterEntries} isLoading={forecastsLoading} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function OverviewSkeleton(): React.JSX.Element {
  return (
    <div className="grid grid-cols-12 gap-2">
      <Card className="col-span-12 h-24 animate-pulse sm:col-span-6 lg:col-span-3" />
      <Card className="col-span-12 h-24 animate-pulse sm:col-span-6 lg:col-span-3" />
      <Card className="col-span-12 h-24 animate-pulse sm:col-span-6 lg:col-span-3" />
      <Card className="col-span-12 h-24 animate-pulse sm:col-span-6 lg:col-span-3" />
      <div className="col-span-12 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card className="h-[294px] animate-pulse" />
        <Card className="h-[294px] animate-pulse" />
        <Card className="h-[294px] animate-pulse" />
        <Card className="h-[294px] animate-pulse" />
      </div>
      <Card className="col-span-12 h-32 animate-pulse" />
    </div>
  );
}
