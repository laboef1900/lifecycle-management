import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { Card } from '@/components/ui/card';
import type { ClusterForecastEntry } from '@/lib/forecast-summary';

import { FleetClusterTileChart } from './fleet-cluster-tile-chart';

interface FleetClusterGridProps {
  entries: ClusterForecastEntry[];
  isLoading?: boolean;
  /** Total number of clusters expected. When greater than entries.length while isLoading,
   *  a "Loading N more…" chip is shown so the page isn't silent during partial loads. */
  total?: number;
}

const SKELETON_COUNT = 4;

function sortKey(entry: ClusterForecastEntry): number {
  if (entry.summary.alreadyBreached === 'crit') return -2;
  if (entry.summary.alreadyBreached === 'warn') return -1;
  if (entry.summary.months !== null) return entry.summary.months;
  return Number.POSITIVE_INFINITY;
}

export function FleetClusterGrid({
  entries,
  isLoading = false,
  total,
}: FleetClusterGridProps): React.JSX.Element | null {
  if (isLoading && entries.length === 0) {
    return (
      <div
        data-testid="grid-skeleton"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      >
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          <Card key={i} className="h-[196px] animate-pulse" />
        ))}
      </div>
    );
  }
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka !== kb) return ka - kb;
    return a.cluster.name.localeCompare(b.cluster.name);
  });
  const remaining =
    isLoading && typeof total === 'number' && total > entries.length ? total - entries.length : 0;
  return (
    <div className="space-y-2">
      {remaining > 0 ? (
        <div
          data-testid="grid-loading-more"
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-fg-muted"
        >
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          <span>
            Loading {remaining} more cluster{remaining === 1 ? '' : 's'}…
          </span>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {sorted.map((entry) => (
          <FleetClusterTileChart key={entry.cluster.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}
