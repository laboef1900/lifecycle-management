import type { ClusterResponse, ForecastResponse } from '@lcm/shared';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';

import { ApplicationsTab } from '@/components/clusters/applications-tab';
import { EventsTab } from '@/components/clusters/events-tab';
import { ForecastChart } from '@/components/clusters/forecast-chart';
import { HostsTab } from '@/components/clusters/hosts-tab';
import { UtilizationPanel } from '@/components/clusters/utilization-panel';
import {
  WindowControls,
  resolveWindow,
  type ForecastWindow,
} from '@/components/clusters/window-controls';
import { KpiTile } from '@/components/overview/kpi-tile';
import { Card } from '@/components/ui/card';
import { RunwayPill } from '@/components/ui/runway-pill';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UtilizationGauge } from '@/components/ui/utilization-gauge';
import { api } from '@/lib/api-client';
import { runwayToWarn, utilStatus } from '@/lib/forecast-summary';

const numberFormat = new Intl.NumberFormat('en-US');

export const Route = createFileRoute('/clusters/$id')({
  component: ClusterDetailPage,
});

function ClusterDetailPage(): React.JSX.Element {
  const { id } = Route.useParams();
  const [windowSelection, setWindowSelection] = useState<ForecastWindow>('24mo');

  const clusterQuery = useQuery({
    queryKey: ['cluster', id],
    queryFn: () => api.clusters.get(id),
  });

  const baselineDate = clusterQuery.data?.baselineDate;
  const metric = clusterQuery.data?.metrics[0];
  const range = baselineDate ? resolveWindow(windowSelection, baselineDate) : null;

  const forecastQuery = useQuery({
    queryKey: ['forecast', id, metric?.metricTypeKey, range?.from, range?.to],
    queryFn: () =>
      api.clusters.forecast(id, {
        metric: metric!.metricTypeKey,
        from: range!.from,
        to: range!.to,
      }),
    enabled: Boolean(metric && range),
  });

  return (
    <div className="space-y-6">
      <div>
        {clusterQuery.isPending ? (
          <HeaderSkeleton />
        ) : clusterQuery.isError || !clusterQuery.data ? (
          <ErrorCard message={clusterQuery.error?.message ?? 'Cluster not found'} />
        ) : (
          <div>
            <h1 className="text-[1.625rem] font-semibold tracking-tight">
              {clusterQuery.data.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              Baseline {clusterQuery.data.baselineDate}
              {clusterQuery.data.description ? ` · ${clusterQuery.data.description}` : null}
            </p>
          </div>
        )}
      </div>

      {clusterQuery.data && metric ? (
        <>
          {forecastQuery.data ? (
            <ClusterDetailKpiStrip forecast={forecastQuery.data} metric={metric} />
          ) : null}

          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Forecast
              </p>
              <h2 className="text-lg font-semibold">Capacity forecast</h2>
            </div>
            <WindowControls value={windowSelection} onChange={setWindowSelection} />
          </div>

          {forecastQuery.isPending ? (
            <ChartSkeleton />
          ) : forecastQuery.isError || !forecastQuery.data ? (
            <ErrorCard message={forecastQuery.error?.message ?? 'Could not load forecast'} />
          ) : (
            <>
              <ForecastChart forecast={forecastQuery.data} />
              <UtilizationPanel forecast={forecastQuery.data} />
            </>
          )}

          <Tabs defaultValue="hosts" className="pt-2">
            <TabsList>
              <TabsTrigger value="hosts">Hosts</TabsTrigger>
              <TabsTrigger value="applications">Applications</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
            </TabsList>
            <TabsContent value="hosts">
              <HostsTab clusterId={id} />
            </TabsContent>
            <TabsContent value="applications">
              <ApplicationsTab clusterId={id} />
            </TabsContent>
            <TabsContent value="events">
              <EventsTab clusterId={id} />
            </TabsContent>
          </Tabs>
        </>
      ) : null}
    </div>
  );
}

function ClusterDetailKpiStrip({
  forecast,
  metric,
}: {
  forecast: ForecastResponse;
  metric: NonNullable<ClusterResponse['metrics'][number]>;
}): React.JSX.Element {
  const headroom = Math.max(0, metric.currentCapacity - metric.currentConsumption);
  const summary = runwayToWarn(forecast.months);
  return (
    <div className="grid grid-cols-12 gap-4">
      <Card className="col-span-12 flex items-center gap-4 p-5 sm:col-span-4">
        <UtilizationGauge value={metric.utilization} size="md" />
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Current utilization
          </p>
          <p className="mt-1 font-mono text-sm tabular-nums text-muted-foreground">
            {numberFormat.format(Math.round(metric.currentConsumption))} GB used
          </p>
        </div>
      </Card>
      <KpiTile
        className="col-span-12 sm:col-span-4"
        label="Headroom"
        value={`${numberFormat.format(Math.round(headroom))} GB`}
        caption={`of ${numberFormat.format(Math.round(metric.currentCapacity))} GB capacity`}
        status={utilStatus(metric.utilization)}
      />
      <Card className="col-span-12 flex flex-col justify-between p-5 sm:col-span-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Runway
        </p>
        <div className="mt-1">
          <RunwayPill summary={summary} horizonMonths={forecast.months.length} />
        </div>
      </Card>
    </div>
  );
}

function HeaderSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="h-7 w-48 animate-pulse rounded bg-muted" />
      <div className="h-4 w-64 animate-pulse rounded bg-muted" />
    </div>
  );
}

function ChartSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <Card className="h-[320px] animate-pulse" />
      <Card className="h-[140px] animate-pulse" />
    </div>
  );
}

function ErrorCard({ message }: { message: string }): React.JSX.Element {
  return (
    <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </Card>
  );
}
