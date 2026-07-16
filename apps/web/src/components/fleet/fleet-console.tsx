import type { ClusterResponse, ProcurementInfo } from '@lcm/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';

import { AdminOnly } from '@/components/auth/admin-only';
import { CreateClusterDialog } from '@/components/clusters/create-cluster-dialog';
import { resolveWindow } from '@/components/clusters/window-controls';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api-client';
import { collectForecastState, earliestOrderByFromFleet } from '@/lib/collect-forecast-state';
import { buildClusterForecastEntries, type ClusterForecastEntry } from '@/lib/forecast-summary';
import { useEffectiveThresholds } from '@/lib/use-effective-thresholds';

import { ClusterTile } from './cluster-tile';
import { FleetVerdict } from './fleet-verdict';
import { OrderByRail, orderByUrgency, type OrderByRailItem } from './order-by-rail';
import { isBaselineStale } from './stale-baseline';

/** The rail only shows order-by dates within the next 12 months (spec §4.2). */
const RAIL_WINDOW_DAYS = 365;

interface SortEntry {
  cluster: ClusterResponse;
  procurement: ProcurementInfo | undefined;
  runwayMonths: number | null;
}

/**
 * Sorts clusters by procurement urgency: ascending order-by date, clusters
 * with no order-by date last, ties (same date, or all-null) broken by
 * ascending runway, then by name. Exported for the fleet console's "sorted by
 * order-by date" tile ordering, and for direct unit testing.
 */
export function sortClustersByUrgency(entries: SortEntry[]): SortEntry[] {
  return [...entries].sort((a, b) => {
    const aDate = a.procurement?.orderByDate ?? null;
    const bDate = b.procurement?.orderByDate ?? null;
    if (aDate !== null && bDate !== null && aDate !== bDate) {
      return aDate < bDate ? -1 : 1;
    }
    if (aDate === null && bDate !== null) return 1;
    if (aDate !== null && bDate === null) return -1;
    const aRunway = a.runwayMonths ?? Number.POSITIVE_INFINITY;
    const bRunway = b.runwayMonths ?? Number.POSITIVE_INFINITY;
    if (aRunway !== bRunway) return aRunway - bRunway;
    return a.cluster.name.localeCompare(b.cluster.name);
  });
}

/**
 * Fleet console (spec §4): the `/` page. Merges the old Overview + Clusters
 * pages into one screen — order-by rail, fleet verdict, and a uniform cluster
 * tile grid sorted by procurement urgency.
 */
export function FleetConsole(): React.JSX.Element {
  const [showArchived, setShowArchived] = useState(false);
  const [linkedClusterId, setLinkedClusterId] = useState<string | null>(null);

  const clustersQuery = useQuery({
    queryKey: ['clusters', { includeArchived: false }],
    queryFn: () => api.clusters.list({ includeArchived: false }),
  });
  const clusters = clustersQuery.data?.items ?? [];

  const archivedClustersQuery = useQuery({
    queryKey: ['clusters', { includeArchived: true }],
    queryFn: () => api.clusters.list({ includeArchived: true }),
    enabled: showArchived,
  });
  const archivedOnly = (archivedClustersQuery.data?.items ?? []).filter(
    (c) => c.archivedAt !== null,
  );

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

  const { summary, forecastsById, errorsById, procurementByClusterId, forecastsLoading } =
    collectForecastState(clusters, forecastQueries);
  // buildClusterForecastEntries only carries {months, thresholds} per cluster
  // (what the runway/sort math needs); ClusterTile also needs the full
  // ForecastResponse for procurement + events, so keep that lookup separately.
  const forecastsByClusterId = new Map(clusters.map((c, i) => [c.id, forecastQueries[i]?.data]));
  const thresholds = useEffectiveThresholds();

  const clusterEntries = buildClusterForecastEntries(clusters, forecastsById, errorsById);
  const entryById = new Map(clusterEntries.map((e) => [e.cluster.id, e]));
  const sortInput: SortEntry[] = clusterEntries.map((e) => ({
    cluster: e.cluster,
    procurement: procurementByClusterId[e.cluster.id],
    runwayMonths: e.summary.months,
  }));
  const sortedEntries = sortClustersByUrgency(sortInput)
    .map((s) => entryById.get(s.cluster.id))
    .filter((e): e is ClusterForecastEntry => e !== undefined);

  const pendingCount = clusters.length - clusterEntries.length;

  const earliest = earliestOrderByFromFleet(clusters, procurementByClusterId);
  const staleCount = clusters.filter((c) => isBaselineStale(c.baselineDate)).length;
  const openOrderCount = clusters.filter((c) => {
    const info = procurementByClusterId[c.id];
    if (!info || info.orderByDate === null) return false;
    const urgency = orderByUrgency(info.orderByDate);
    return urgency === 'now' || urgency === 'soon';
  }).length;

  const today = new Date();
  const railItems: OrderByRailItem[] = clusters.flatMap((c) => {
    const info = procurementByClusterId[c.id];
    if (!info || info.orderByDate === null) return [];
    const days = Math.round(
      (new Date(`${info.orderByDate}T00:00:00Z`).getTime() - today.getTime()) / 86_400_000,
    );
    if (days > RAIL_WINDOW_DAYS) return [];
    return [
      {
        clusterId: c.id,
        name: c.name,
        orderByDate: info.orderByDate,
        leadTimeWeeks: info.leadTimeWeeks,
      },
    ];
  });

  const isLoading = clustersQuery.isPending;
  const isError = clustersQuery.isError;
  const isEmpty = !isLoading && !isError && clusters.length === 0;

  return (
    <div className="space-y-3">
      {isError ? (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive shadow-none">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Could not load clusters: {clustersQuery.error?.message}</span>
        </Card>
      ) : null}

      {isLoading ? <ConsoleSkeleton /> : null}

      {isEmpty ? (
        <EmptyState
          title="No clusters yet."
          description="Add a cluster to start tracking memory capacity and forecasting growth."
          action={
            <AdminOnly>
              <CreateClusterDialog />
            </AdminOnly>
          }
        />
      ) : null}

      {!isLoading && !isError && clusters.length > 0 ? (
        <>
          <OrderByRail
            items={railItems}
            {...(linkedClusterId ? { linkedId: linkedClusterId } : {})}
            onTickHover={setLinkedClusterId}
          />

          <div className="flex items-center justify-end gap-2">
            <AdminOnly>
              <CreateClusterDialog />
            </AdminOnly>
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="inline-flex h-8 items-center gap-2 rounded-[var(--radius)] border border-border bg-background px-2.5 text-xs font-medium text-fg-muted transition-colors hover:bg-card-hover hover:text-foreground"
              aria-pressed={showArchived}
            >
              <span
                aria-hidden
                className={`inline-block h-2 w-2 rounded-full ${showArchived ? 'bg-accent' : 'bg-border'}`}
              />
              {showArchived ? 'Hide archived' : 'Show archived'}
            </button>
          </div>

          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-12">
              <FleetVerdict
                summary={summary}
                earliest={earliest}
                staleCount={staleCount}
                openOrderCount={openOrderCount}
              />
            </div>

            <p
              role="note"
              className="col-span-12 -mt-1 mb-[-4px] text-right text-[9px] font-semibold uppercase tracking-[0.14em] text-fg-subtle"
            >
              Sorted by order-by date
            </p>

            {sortedEntries.map((entry) => (
              <div
                key={entry.cluster.id}
                className="col-span-12 min-[820px]:col-span-6 min-[1280px]:col-span-4"
                onMouseEnter={() => setLinkedClusterId(entry.cluster.id)}
                onMouseLeave={() => setLinkedClusterId(null)}
                onFocus={() => setLinkedClusterId(entry.cluster.id)}
                onBlur={() => setLinkedClusterId(null)}
              >
                <ClusterTile
                  entry={entry}
                  forecast={forecastsByClusterId.get(entry.cluster.id)}
                  thresholds={entry.thresholds}
                  linked={linkedClusterId === entry.cluster.id}
                />
              </div>
            ))}

            {forecastsLoading
              ? Array.from({ length: Math.max(0, pendingCount) }).map((_, i) => (
                  <div
                    key={`skeleton-${i}`}
                    className="col-span-12 min-[820px]:col-span-6 min-[1280px]:col-span-4"
                  >
                    <Skeleton className="h-[260px] w-full" />
                  </div>
                ))
              : null}

            {showArchived
              ? archivedOnly.map((cluster) => (
                  <div
                    key={cluster.id}
                    className="col-span-12 min-[820px]:col-span-6 min-[1280px]:col-span-4"
                  >
                    <ClusterTile
                      entry={{
                        cluster,
                        months: [],
                        thresholds,
                        summary: { months: null, alreadyBreached: false },
                      }}
                      forecast={undefined}
                      thresholds={thresholds}
                    />
                  </div>
                ))
              : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ConsoleSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-3">
      <Skeleton className="h-[110px] w-full" />
      <Skeleton className="h-[140px] w-full" />
      <div className="grid grid-cols-12 gap-3">
        <Skeleton className="col-span-12 h-[260px] min-[820px]:col-span-6 min-[1280px]:col-span-4" />
        <Skeleton className="col-span-12 h-[260px] min-[820px]:col-span-6 min-[1280px]:col-span-4" />
        <Skeleton className="col-span-12 h-[260px] min-[820px]:col-span-6 min-[1280px]:col-span-4" />
      </div>
    </div>
  );
}
