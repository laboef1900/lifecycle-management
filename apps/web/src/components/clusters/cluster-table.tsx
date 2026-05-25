import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { RunwayPill } from '@/components/ui/runway-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { runwayToWarn } from '@/lib/forecast-summary';
import { cn } from '@/lib/utils';

import { ClusterListCard } from './cluster-list-card';
import { UtilizationBadge } from './utilization-badge';

export interface ClusterForecastEntry {
  months: ForecastMonthPoint[];
  thresholds: { warn: number; crit: number };
}

interface ClusterTableProps {
  clusters: ClusterResponse[];
  /** Per-cluster forecast months + effective thresholds, keyed by cluster id. Runway shows '—' when missing. */
  forecastsById?: Record<string, ClusterForecastEntry>;
  horizonMonths?: number;
}

type SortKey = 'name' | 'consumption' | 'capacity' | 'utilization' | 'runway';
type SortDir = 'asc' | 'desc';

interface SortState {
  key: SortKey;
  dir: SortDir;
}

const numberFormat = new Intl.NumberFormat('en-US');
// Used as the "no breach" sentinel for sort ordering — larger than any realistic horizon.
const RUNWAY_NONE = Number.POSITIVE_INFINITY;

interface Row {
  cluster: ClusterResponse;
  summary: ReturnType<typeof runwayToWarn> | undefined;
  thresholds: { warn: number; crit: number } | undefined;
  sortRunway: number;
}

export function ClusterTable({
  clusters,
  forecastsById,
  horizonMonths,
}: ClusterTableProps): React.JSX.Element {
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });

  const rows = useMemo<Row[]>(
    () =>
      clusters.map((cluster) => {
        const entry = forecastsById?.[cluster.id];
        const summary = entry ? runwayToWarn(entry.months, entry.thresholds) : undefined;
        const sortRunway =
          summary === undefined
            ? RUNWAY_NONE
            : summary.alreadyBreached !== false
              ? 0
              : (summary.months ?? RUNWAY_NONE);
        return { cluster, summary, thresholds: entry?.thresholds, sortRunway };
      }),
    [clusters, forecastsById],
  );

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const aValue = extractSortValue(a, sort.key);
      const bValue = extractSortValue(b, sort.key);
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return sort.dir === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
      }
      const aN = aValue as number;
      const bN = bValue as number;
      if (aN === bN) return 0;
      return sort.dir === 'asc' ? aN - bN : bN - aN;
    });
    return copy;
  }, [rows, sort]);

  const toggle = (key: SortKey): void => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  };

  return (
    <>
      <div className="space-y-2 md:hidden">
        {sorted.map(({ cluster, thresholds }) => {
          const entry = forecastsById?.[cluster.id];
          return (
            <ClusterListCard
              key={cluster.id}
              cluster={cluster}
              months={entry?.months ?? []}
              horizonMonths={horizonMonths ?? 0}
              {...(thresholds && { thresholds })}
            />
          );
        })}
      </div>
      <Card className="hidden overflow-hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead label="Cluster" sortKey="name" sort={sort} onToggle={toggle} />
              <SortableHead
                label="Consumption (GB)"
                sortKey="consumption"
                sort={sort}
                onToggle={toggle}
                align="right"
              />
              <SortableHead
                label="Capacity (GB)"
                sortKey="capacity"
                sort={sort}
                onToggle={toggle}
                align="right"
              />
              <SortableHead
                label="Utilization"
                sortKey="utilization"
                sort={sort}
                onToggle={toggle}
                align="right"
              />
              <SortableHead label="Runway" sortKey="runway" sort={sort} onToggle={toggle} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map(({ cluster, summary, thresholds }) => {
              const metric = cluster.metrics[0];
              return (
                <TableRow
                  key={cluster.id}
                  className="cursor-pointer hover:bg-muted/60 focus-within:bg-muted/60"
                >
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-2">
                      <Link
                        to="/clusters/$id"
                        params={{ id: cluster.id }}
                        className="focus-visible:outline-none"
                      >
                        {cluster.name}
                      </Link>
                      {cluster.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {metric ? numberFormat.format(Math.round(metric.currentConsumption)) : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {metric ? numberFormat.format(Math.round(metric.currentCapacity)) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {metric ? <UtilizationBadge value={metric.utilization} /> : '—'}
                  </TableCell>
                  <TableCell>
                    {summary === undefined ? (
                      '—'
                    ) : (
                      <RunwayPill
                        summary={summary}
                        {...(horizonMonths !== undefined && { horizonMonths })}
                        {...(thresholds && { thresholds })}
                      />
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}

function extractSortValue(row: Row, key: SortKey): string | number {
  const metric = row.cluster.metrics[0];
  switch (key) {
    case 'name':
      return row.cluster.name.toLowerCase();
    case 'consumption':
      return metric?.currentConsumption ?? 0;
    case 'capacity':
      return metric?.currentCapacity ?? 0;
    case 'utilization':
      return metric?.utilization ?? 0;
    case 'runway':
      return row.sortRunway;
  }
}

interface SortableHeadProps {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onToggle: (key: SortKey) => void;
  align?: 'left' | 'right';
}

function SortableHead({
  label,
  sortKey,
  sort,
  onToggle,
  align = 'left',
}: SortableHeadProps): React.JSX.Element {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 rounded hover:text-foreground',
          align === 'right' && 'ml-auto flex-row-reverse',
          active && 'text-foreground',
        )}
        aria-sort={!active ? 'none' : sort.dir === 'asc' ? 'ascending' : 'descending'}
      >
        <span>{label}</span>
        <Icon className="h-3.5 w-3.5" />
      </button>
    </TableHead>
  );
}
