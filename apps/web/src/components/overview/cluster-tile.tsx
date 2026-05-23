import type { ClusterResponse } from '@lcm/shared';
import { Link } from '@tanstack/react-router';
import * as React from 'react';

import { UtilizationBadge } from '@/components/clusters/utilization-badge';
import { Sparkline } from '@/components/sparkline';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface ClusterTileProps extends React.HTMLAttributes<HTMLAnchorElement> {
  cluster: ClusterResponse;
  trend: number[];
  trendCeiling?: number[];
}

const numberFormat = new Intl.NumberFormat('en-US');

export function ClusterTile({
  cluster,
  trend,
  trendCeiling,
  className,
  ...props
}: ClusterTileProps): React.JSX.Element {
  const metric = cluster.metrics[0];
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
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="truncate text-base font-semibold">{cluster.name}</h3>
          {metric ? <UtilizationBadge value={metric.utilization} /> : null}
        </div>
        {metric ? (
          <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
            {numberFormat.format(Math.round(metric.currentConsumption))} /{' '}
            {numberFormat.format(Math.round(metric.currentCapacity))} GB
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No baseline</p>
        )}
        {trend.length >= 2 ? (
          <div className="mt-3">
            <Sparkline
              values={trend}
              {...(trendCeiling ? { ceiling: trendCeiling } : {})}
              width={240}
              height={36}
            />
          </div>
        ) : null}
      </Card>
    </Link>
  );
}
