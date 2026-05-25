import type { ClusterResponse, ForecastResponse } from '@lcm/shared';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';

import { ApplicationsTab } from '@/components/clusters/applications-tab';
import { EventsTab } from '@/components/clusters/events-tab';
import { ForecastChart } from '@/components/clusters/forecast-chart';
import { HostsTab } from '@/components/clusters/hosts-tab';
import { SettingsTab } from '@/components/clusters/settings-tab';
import {
  WindowControls,
  resolveWindow,
  type ForecastWindow,
} from '@/components/clusters/window-controls';
import { KpiTile } from '@/components/overview/kpi-tile';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { RunwayPill } from '@/components/ui/runway-pill';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UtilizationGauge } from '@/components/ui/utilization-gauge';
import { api } from '@/lib/api-client';
import { runwayToWarn, utilStatus } from '@/lib/forecast-summary';
import { useMediaQuery } from '@/lib/use-media-query';

const numberFormat = new Intl.NumberFormat('en-US');

export const Route = createFileRoute('/clusters/$id')({
  component: ClusterDetailPage,
});

function ClusterDetailPage(): React.JSX.Element {
  const { id } = Route.useParams();
  const [windowSelection, setWindowSelection] = useState<ForecastWindow>('24mo');
  const isWide = useMediaQuery('(min-width: 640px)');

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
          <header>
            <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
              Cluster
            </p>
            <div className="mt-1 flex flex-wrap items-baseline gap-2">
              <h1 className="text-[26px] font-semibold leading-[1.1] tracking-[-0.02em] [overflow-wrap:anywhere]">
                {clusterQuery.data.name}
              </h1>
              {clusterQuery.data.archivedAt ? (
                <Badge variant="outline">
                  Archived {clusterQuery.data.archivedAt.slice(0, 10)}
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Baseline {clusterQuery.data.baselineDate}
              {clusterQuery.data.description ? ` · ${clusterQuery.data.description}` : null}
            </p>
          </header>
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
            <ForecastChart forecast={forecastQuery.data} compact={!isWide} />
          )}

          <Tabs defaultValue="hosts" className="pt-2">
            <TabsList>
              <TabsTrigger value="hosts">Hosts</TabsTrigger>
              <TabsTrigger value="applications">Applications</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
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
            <TabsContent value="settings">
              <SettingsTab clusterId={id} />
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
  const summary = runwayToWarn(forecast.months, forecast.effectiveThresholds);
  return (
    <div data-testid="kpi-strip" className="grid grid-cols-12 gap-2">
      <Card className="col-span-12 flex items-center gap-4 p-3.5 sm:col-span-4">
        <UtilizationGauge
          value={metric.utilization}
          size="md"
          warn={forecast.effectiveThresholds.warn}
          crit={forecast.effectiveThresholds.crit}
        />
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Current utilization
          </p>
          <p className="mt-1.5 font-mono text-[11px] tabular-nums text-fg-muted">
            {numberFormat.format(Math.round(metric.currentConsumption))} GB used
          </p>
        </div>
      </Card>
      <KpiTile
        className="col-span-12 sm:col-span-4"
        label="Headroom"
        value={`${numberFormat.format(Math.round(headroom))} GB`}
        caption={`of ${numberFormat.format(Math.round(metric.currentCapacity))} GB capacity`}
        status={utilStatus(metric.utilization, forecast.effectiveThresholds)}
      />
      <Card className="col-span-12 flex flex-col justify-between p-3.5 sm:col-span-4">
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">Runway</p>
        <div className="mt-1.5">
          <RunwayPill
            summary={summary}
            horizonMonths={forecast.months.length}
            thresholds={forecast.effectiveThresholds}
          />
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
