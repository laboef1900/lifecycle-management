import { Link } from '@tanstack/react-router';
import * as React from 'react';
import {
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card } from '@/components/ui/card';
import { RunwayPill } from '@/components/ui/runway-pill';
import type { ClusterForecastEntry } from '@/lib/forecast-summary';
import { useChartColors } from '@/lib/use-chart-colors';

interface FleetClusterTileChartProps {
  entry: ClusterForecastEntry;
}

function formatMonth(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

export function FleetClusterTileChart({ entry }: FleetClusterTileChartProps): React.JSX.Element {
  const { cluster, months, thresholds, summary } = entry;
  const colors = useChartColors();
  const data = months.map((m) => ({
    month: m.month,
    util: m.capacity > 0 ? m.consumption / m.capacity : 0,
  }));
  const hasData = data.length > 0;

  return (
    <Link
      to="/clusters/$id"
      params={{ id: cluster.id }}
      className="block rounded-[var(--radius-card)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card className="flex h-[180px] flex-col gap-2 p-3.5 transition-colors hover:border-fg-subtle/40">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 truncate text-sm font-semibold tracking-tight">{cluster.name}</h3>
          <RunwayPill summary={summary} horizonMonths={months.length} thresholds={thresholds} />
        </div>
        {hasData ? (
          <div className="h-[110px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <YAxis hide domain={[0, 1]} />
                <XAxis dataKey="month" hide />
                <ReferenceArea
                  y1={thresholds.warn}
                  y2={thresholds.crit}
                  fill={colors.utilizationWarn}
                  fillOpacity={0.1}
                  stroke="none"
                />
                <ReferenceArea
                  y1={thresholds.crit}
                  y2={1}
                  fill={colors.utilizationCrit}
                  fillOpacity={0.12}
                  stroke="none"
                />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0 || typeof label !== 'string') {
                      return null;
                    }
                    const util = (payload[0]?.value as number) ?? 0;
                    return (
                      <div className="rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-[var(--overlay-shadow)]">
                        <span className="font-medium">{formatMonth(label)}</span>
                        <span className="ml-2 font-mono tabular-nums">
                          {(util * 100).toFixed(1)}%
                        </span>
                      </div>
                    );
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="util"
                  stroke={colors.consumption}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-[110px] items-center justify-center text-xs text-fg-muted">
            No forecast
          </div>
        )}
      </Card>
    </Link>
  );
}
