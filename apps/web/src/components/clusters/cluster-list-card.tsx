import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { Link } from '@tanstack/react-router';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { RunwayPill } from '@/components/ui/runway-pill';
import { runwayToWarn } from '@/lib/forecast-summary';

import { UtilizationBadge } from './utilization-badge';

interface ClusterListCardProps {
  cluster: ClusterResponse;
  months: ForecastMonthPoint[];
  horizonMonths: number;
  thresholds?: { warn: number; crit: number };
}

const numberFormat = new Intl.NumberFormat('en-US');

export function ClusterListCard({
  cluster,
  months,
  horizonMonths,
  thresholds,
}: ClusterListCardProps): React.JSX.Element {
  const metric = cluster.metrics[0];
  const summary = metric && months.length > 0 ? runwayToWarn(months, thresholds) : undefined;

  return (
    <Link
      to="/clusters/$id"
      params={{ id: cluster.id }}
      className="block rounded-xl transition-shadow duration-150 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate text-base font-semibold [overflow-wrap:anywhere]">
              {cluster.name}
            </h3>
            {cluster.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
          </span>
          {metric ? <UtilizationBadge value={metric.utilization} /> : null}
        </div>
        {metric ? (
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            {numberFormat.format(Math.round(metric.currentConsumption))} /{' '}
            {numberFormat.format(Math.round(metric.currentCapacity))} GB
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No baseline</p>
        )}
        {summary ? (
          <RunwayPill
            summary={summary}
            {...(horizonMonths > 0 && { horizonMonths })}
            {...(thresholds && { thresholds })}
          />
        ) : null}
      </Card>
    </Link>
  );
}
