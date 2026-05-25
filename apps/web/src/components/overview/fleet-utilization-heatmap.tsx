import * as React from 'react';

import { Card } from '@/components/ui/card';
import type { ClusterForecastEntry } from '@/lib/forecast-summary';
import { utilStatus, type UtilStatus } from '@/lib/forecast-summary';

interface FleetUtilizationHeatmapProps {
  entries: ClusterForecastEntry[];
  isLoading?: boolean;
}

interface HeatmapCell {
  month: string;
  util: number | null;
  status: UtilStatus | 'empty';
}

const SKELETON_ROWS = 4;
const SKELETON_COLS = 12;

const STATUS_CLASS: Record<UtilStatus | 'empty', string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  crit: 'bg-destructive',
  empty: 'bg-muted',
};

function formatMonthShort(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

function formatMonthLong(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function currentUtilization(entry: ClusterForecastEntry): number {
  return entry.cluster.metrics[0]?.utilization ?? 0;
}

export function FleetUtilizationHeatmap({
  entries,
  isLoading = false,
}: FleetUtilizationHeatmapProps): React.JSX.Element | null {
  if (isLoading && entries.length === 0) {
    return (
      <Card data-testid="heatmap-skeleton" className="p-4">
        <div className="space-y-2">
          {Array.from({ length: SKELETON_ROWS }).map((_, r) => (
            <div key={r} className="flex items-center gap-1">
              <div className="h-3 w-24 animate-pulse rounded bg-muted" />
              {Array.from({ length: SKELETON_COLS }).map((_, c) => (
                <div key={c} className="h-3 w-3 animate-pulse rounded-sm bg-muted" />
              ))}
            </div>
          ))}
        </div>
      </Card>
    );
  }
  if (entries.length === 0) return null;

  const monthSet = new Set<string>();
  for (const entry of entries) for (const m of entry.months) monthSet.add(m.month);
  const months = Array.from(monthSet).sort();

  const sorted = [...entries].sort((a, b) => {
    const ua = currentUtilization(a);
    const ub = currentUtilization(b);
    if (ua !== ub) return ub - ua;
    return a.cluster.name.localeCompare(b.cluster.name);
  });

  const rows = sorted.map((entry) => {
    const byMonth = new Map(entry.months.map((m) => [m.month, m]));
    const cells: HeatmapCell[] = months.map((month) => {
      const point = byMonth.get(month);
      if (!point || point.capacity <= 0) return { month, util: null, status: 'empty' };
      const util = point.consumption / point.capacity;
      return { month, util, status: utilStatus(util, entry.thresholds) };
    });
    return { entry, cells };
  });

  return (
    <Card className="overflow-x-auto p-4">
      <table className="w-full border-separate border-spacing-1 text-xs">
        <caption className="sr-only">Fleet utilization heatmap (cluster by month)</caption>
        <thead>
          <tr>
            <th scope="col" className="text-left font-medium text-fg-muted">
              Cluster
            </th>
            {months.map((m, i) => (
              <th
                key={m}
                scope="col"
                className={
                  i % 3 === 0
                    ? 'text-center font-mono text-[10px] font-normal text-fg-muted'
                    : 'hidden text-center font-mono text-[10px] font-normal text-fg-muted md:table-cell'
                }
              >
                {formatMonthShort(m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ entry, cells }) => (
            <tr key={entry.cluster.id}>
              <th scope="row" className="whitespace-nowrap text-left font-medium text-foreground">
                {entry.cluster.name}
                {entry.error ? (
                  <span
                    className="ml-1.5 text-[10px] font-normal text-destructive"
                    title={`Forecast load failed: ${entry.error}`}
                  >
                    (failed)
                  </span>
                ) : null}
              </th>
              {cells.map((cell, i) => {
                const pct = cell.util === null ? null : (cell.util * 100).toFixed(1);
                const label =
                  pct === null
                    ? `${formatMonthLong(cell.month)} — no data`
                    : `${formatMonthLong(cell.month)} — ${pct}% (${cell.status})`;
                const hideOnMobile = i % 3 !== 0;
                return (
                  <td
                    key={cell.month}
                    data-testid={`cell-${entry.cluster.id}-${cell.month}`}
                    data-status={cell.status}
                    aria-label={label}
                    title={label}
                    className={hideOnMobile ? 'hidden p-0 md:table-cell' : 'p-0'}
                  >
                    <span
                      aria-hidden
                      className={`block h-3 w-3 rounded-sm ${STATUS_CLASS[cell.status]}`}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
