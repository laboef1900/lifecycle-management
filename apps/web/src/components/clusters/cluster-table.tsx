import type { ClusterResponse } from '@lcm/shared';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

import { ClusterSparklineCell } from './cluster-sparkline-cell';
import { UtilizationBadge } from './utilization-badge';

interface ClusterTableProps {
  clusters: ClusterResponse[];
}

type SortKey = 'name' | 'consumption' | 'capacity' | 'utilization';
type SortDir = 'asc' | 'desc';

interface SortState {
  key: SortKey;
  dir: SortDir;
}

const numberFormat = new Intl.NumberFormat('en-US');

export function ClusterTable({ clusters }: ClusterTableProps): React.JSX.Element {
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });

  const sorted = useMemo(() => {
    const copy = [...clusters];
    copy.sort((a, b) => {
      const aValue = extractSortValue(a, sort.key);
      const bValue = extractSortValue(b, sort.key);
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return sort.dir === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
      }
      return sort.dir === 'asc'
        ? (aValue as number) - (bValue as number)
        : (bValue as number) - (aValue as number);
    });
    return copy;
  }, [clusters, sort]);

  const toggle = (key: SortKey): void => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  };

  return (
    <Card className="overflow-hidden">
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
            <TableHead>12-month trend</TableHead>
            <TableHead className="w-20 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((cluster) => {
            const metric = cluster.metrics[0];
            return (
              <TableRow key={cluster.id} className="hover:bg-muted/60">
                <TableCell className="font-medium">{cluster.name}</TableCell>
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
                  {metric ? (
                    <ClusterSparklineCell clusterId={cluster.id} metricKey={metric.metricTypeKey} />
                  ) : null}
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild variant="ghost" size="sm">
                    <Link to="/clusters/$id" params={{ id: cluster.id }}>
                      Open
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

function extractSortValue(cluster: ClusterResponse, key: SortKey): string | number {
  const metric = cluster.metrics[0];
  switch (key) {
    case 'name':
      return cluster.name.toLowerCase();
    case 'consumption':
      return metric?.currentConsumption ?? 0;
    case 'capacity':
      return metric?.currentCapacity ?? 0;
    case 'utilization':
      return metric?.utilization ?? 0;
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
