import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { Link } from '@tanstack/react-router';
import * as React from 'react';

import { RunwayPill } from '@/components/ui/runway-pill';
import { UtilizationGauge } from '@/components/ui/utilization-gauge';
import { Card } from '@/components/ui/card';
import { runwayToWarn } from '@/lib/forecast-summary';
import { cn } from '@/lib/utils';

interface ClusterTileProps extends React.HTMLAttributes<HTMLAnchorElement> {
  cluster: ClusterResponse;
  forecastMonths: ForecastMonthPoint[];
  horizonMonths: number;
}

const numberFormat = new Intl.NumberFormat('en-US');

export function ClusterTile({
  cluster,
  forecastMonths,
  horizonMonths,
  className,
  ...props
}: ClusterTileProps): React.JSX.Element {
  const metric = cluster.metrics[0];
  const summary = metric ? runwayToWarn(forecastMonths) : undefined;
  return (
    <Link
      to="/clusters/$id"
      params={{ id: cluster.id }}
      className={cn(
        'block rounded-xl transition-shadow duration-150 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className,
      )}
      {...props}
    >
      <Card className="flex h-[136px] items-center gap-4 p-4">
        <UtilizationGauge value={metric?.utilization} size="lg" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold">{cluster.name}</h3>
          {metric ? (
            <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
              {numberFormat.format(Math.round(metric.currentConsumption))} /{' '}
              {numberFormat.format(Math.round(metric.currentCapacity))} GB
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">No baseline</p>
          )}
          <div className="mt-3">
            <RunwayPill summary={summary} horizonMonths={horizonMonths} />
          </div>
        </div>
      </Card>
    </Link>
  );
}
