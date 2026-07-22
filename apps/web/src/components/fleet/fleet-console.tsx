import type { ClusterResponse, ProcurementInfo } from '@lcm/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Boxes } from 'lucide-react';
import { useCallback, useState } from 'react';

import { AdminOnly } from '@/components/auth/admin-only';
import { resolveWindow } from '@/components/clusters/window-controls';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ADD_CLUSTER_HASH } from '@/lib/anchors';
import { api } from '@/lib/api-client';
import { collectForecastState, earliestOrderByFromFleet } from '@/lib/collect-forecast-state';
import { buildClusterForecastEntries, type ClusterForecastEntry } from '@/lib/forecast-summary';
import { useEffectiveThresholds } from '@/lib/use-effective-thresholds';

import { ClusterTile } from './cluster-tile';
import { FleetFilter } from './fleet-filter';
import { FleetSort, type ClusterSortMode } from './fleet-sort';
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

/** A cluster's total tracked memory capacity — the "Size" sort key. */
function clusterTotalCapacity(cluster: ClusterResponse): number {
  return cluster.metrics.reduce((sum, m) => sum + m.currentCapacity, 0);
}

/**
 * Sorts cluster entries by the selected mode (#267). `orderBy` is procurement
 * urgency (the default, delegated to {@link sortClustersByUrgency}); `name` is
 * alphabetical; `size` is total memory capacity, largest first. Name and size
 * both fall back to name for a stable, deterministic order. Never mutates the
 * input. Exported for direct unit testing.
 */
export function sortClusters(entries: SortEntry[], mode: ClusterSortMode): SortEntry[] {
  if (mode === 'orderBy') return sortClustersByUrgency(entries);
  if (mode === 'name') {
    return [...entries].sort((a, b) => a.cluster.name.localeCompare(b.cluster.name));
  }
  return [...entries].sort((a, b) => {
    const sizeDelta = clusterTotalCapacity(b.cluster) - clusterTotalCapacity(a.cluster);
    if (sizeDelta !== 0) return sizeDelta;
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
  const [sortMode, setSortMode] = useState<ClusterSortMode>('orderBy');
  // Whether the user has operated the archived filter at least once this
  // mount: gates the sr-only announcement below so the status region never
  // "announces" the default state on load.
  const [archivedTouched, setArchivedTouched] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [linkedClusterId, setLinkedClusterId] = useState<string | null>(null);
  // Stable across renders (PR review fix 4d) so the per-tile wrapper's
  // hover/focus props don't force `ClusterTile` (now `memo`-wrapped) to
  // treat every tile as changed just because FleetConsole re-rendered.
  const handleTileLinkStart = useCallback((id: string) => setLinkedClusterId(id), []);
  const handleTileLinkEnd = useCallback(() => setLinkedClusterId(null), []);
  const handleShowArchivedChange = useCallback((next: boolean) => {
    setShowArchived(next);
    setArchivedTouched(true);
  }, []);

  const clustersQuery = useQuery({
    queryKey: ['clusters', { includeArchived: false }],
    queryFn: () => api.clusters.list({ includeArchived: false }),
  });
  const clusters = clustersQuery.data?.items ?? [];

  // Batch live usage for every synced cluster, in one request (#193). Keyed so
  // the cluster detail panel reuses this exact cache and picks out its own
  // item — no per-cluster round-trip. Manual clusters are simply absent.
  const liveUsageQuery = useQuery({
    queryKey: ['clusters', 'live-usage'],
    queryFn: () => api.clusters.liveUsage(),
  });
  const liveUsageById = new Map((liveUsageQuery.data?.items ?? []).map((u) => [u.clusterId, u]));
  const liveUsagePending = liveUsageQuery.isPending;

  // Enabled while the Filter popover is open too (#243), not only once the
  // toggle is on: the popover's "Show archived (N)" item carries the live
  // count, so the count must be real by the time the user reads the item.
  const archivedClustersQuery = useQuery({
    queryKey: ['clusters', { includeArchived: true }],
    queryFn: () => api.clusters.list({ includeArchived: true }),
    enabled: showArchived || filterOpen,
  });
  const archivedOnly = (archivedClustersQuery.data?.items ?? []).filter(
    (c) => c.archivedAt !== null,
  );
  const archivedCount = archivedClustersQuery.data ? archivedOnly.length : null;

  // Filter-change announcement (#243, WCAG 4.1.3-adjacent): describes the
  // resulting mixed view in words. Derived, so when the archived list arrives
  // after the toggle the message refines itself in place; gated on
  // `archivedTouched` so page load announces nothing.
  const visibleCount = clusters.length + (showArchived ? archivedOnly.length : 0);
  const archiveAnnouncement = !archivedTouched
    ? ''
    : showArchived
      ? archivedCount === null
        ? 'Showing archived clusters.'
        : `Showing ${visibleCount} cluster${visibleCount === 1 ? '' : 's'} including ${archivedOnly.length} archived.`
      : `Showing ${clusters.length} cluster${clusters.length === 1 ? '' : 's'}.`;

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
  const sortedEntries = sortClusters(sortInput, sortMode)
    .map((s) => entryById.get(s.cluster.id))
    .filter((e): e is ClusterForecastEntry => e !== undefined);

  const pendingCount = clusters.length - clusterEntries.length;

  // Spec §4.3's "clusters · hosts" instrument: sum ForecastEntityContribution
  // rows across clusters with a resolved forecast (errored clusters have no
  // entry in forecastsByClusterId and so contribute 0). `null` while any
  // forecast is still in flight, so the verdict shows the cluster count alone
  // rather than an undercount.
  const hostCount = forecastsLoading
    ? null
    : clusters.reduce((sum, c) => sum + (forecastsByClusterId.get(c.id)?.hosts.length ?? 0), 0);

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

  // Every render branch needs exactly one h1 (the happy path's is
  // FleetVerdict's headline) — the loading/error/empty branches below don't
  // have a natural heading of their own, so they each get a visually-hidden
  // one instead of leaving the page headingless.
  return (
    <div className="space-y-3">
      <div
        data-testid="fleet-filter-announcement"
        className="sr-only"
        role="status"
        aria-live="polite"
      >
        {archiveAnnouncement}
      </div>
      {isError ? (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive shadow-none">
          <h1 className="sr-only">Fleet capacity console</h1>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Could not load clusters: {clustersQuery.error?.message}</span>
        </Card>
      ) : null}

      {isLoading ? (
        <>
          <h1 className="sr-only">Fleet capacity console</h1>
          <ConsoleSkeleton />
        </>
      ) : null}

      {isEmpty ? (
        <>
          <h1 className="sr-only">Fleet capacity console</h1>
          {/* The large call-to-action fills the area the cluster-tile grid
              would occupy (#223). Adding a cluster is a configuration task, so
              the action lives in Settings — this only points there, deep-linked
              to the Add-cluster panel. Admin-only, as the create action was;
              viewers get a plain explanation. */}
          <EmptyState
            size="hero"
            icon={<Boxes />}
            title="No clusters yet"
            description="Add a cluster to start tracking memory capacity and forecasting growth. Clusters are managed in Settings, alongside your vCenter connections."
            action={
              <AdminOnly
                fallback={
                  <p className="text-xs text-fg-subtle">
                    Ask an administrator to add a cluster in Settings.
                  </p>
                }
              >
                <Button asChild variant="accent" size="lg">
                  <Link to="/settings/inventory" hash={ADD_CLUSTER_HASH}>
                    Add a cluster in Settings
                  </Link>
                </Button>
              </AdminOnly>
            }
          />
        </>
      ) : null}

      {!isLoading && !isError && clusters.length > 0 ? (
        <>
          <OrderByRail
            items={railItems}
            {...(linkedClusterId ? { linkedId: linkedClusterId } : {})}
            onTickHover={setLinkedClusterId}
          />

          <FleetVerdict
            summary={summary}
            earliest={earliest}
            staleCount={staleCount}
            openOrderCount={openOrderCount}
            hostCount={hostCount}
          />

          {/* The cluster tiles live in a single titled pane (#267). The
              Order-by rail and Fleet verdict above stay outside it. The pane
              header carries the Sort selector and the Filter popover — controls
              attached to the list they act on, replacing the old stranded
              toolbar row and its static "sorted by" note. */}
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-3">
              <h2 className="text-sm font-semibold leading-none tracking-tight">Clusters</h2>
              <div className="flex items-center gap-2">
                <FleetSort value={sortMode} onValueChange={setSortMode} />
                <FleetFilter
                  showArchived={showArchived}
                  onShowArchivedChange={handleShowArchivedChange}
                  archivedCount={archivedCount}
                  open={filterOpen}
                  onOpenChange={setFilterOpen}
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-12 gap-3">
                {sortedEntries.map((entry) => (
                  <div
                    key={entry.cluster.id}
                    className="col-span-12 min-[820px]:col-span-6 min-[1280px]:col-span-4"
                    onMouseEnter={() => handleTileLinkStart(entry.cluster.id)}
                    onMouseLeave={handleTileLinkEnd}
                    onFocus={() => handleTileLinkStart(entry.cluster.id)}
                    onBlur={handleTileLinkEnd}
                  >
                    <ClusterTile
                      entry={entry}
                      forecast={forecastsByClusterId.get(entry.cluster.id)}
                      thresholds={entry.thresholds}
                      linked={linkedClusterId === entry.cluster.id}
                      live={liveUsageById.get(entry.cluster.id)}
                      liveUsagePending={liveUsagePending}
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
            </CardContent>
          </Card>
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
