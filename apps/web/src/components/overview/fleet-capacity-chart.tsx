import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { useChartColors } from '@/lib/use-chart-colors';

interface FleetMonthRow {
  month: string;
  capacityTotal: number;
  [clusterId: string]: number | string;
}

interface ClusterMeta {
  clusterId: string;
  clusterName: string;
}

interface FleetCapacityChartProps {
  fleetMonths: FleetMonthRow[];
  clusters: ClusterMeta[];
}

const numberFormat = new Intl.NumberFormat('en-US');

function formatMonth(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

export function FleetCapacityChart({
  fleetMonths,
  clusters,
}: FleetCapacityChartProps): React.JSX.Element {
  const colors = useChartColors();

  return (
    <div className="w-full">
      <div className="h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={fleetMonths} margin={{ top: 12, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
            <XAxis
              dataKey="month"
              tickFormatter={formatMonth}
              tick={{ fontSize: 11 }}
              stroke={colors.axis}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis
              tick={{ fontSize: 11 }}
              stroke={colors.axis}
              tickFormatter={(v: number) => numberFormat.format(v)}
              label={{
                value: 'GB',
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: 11, fill: colors.axis },
              }}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0 || typeof label !== 'string') {
                  return null;
                }
                const capacity =
                  (payload.find((p) => p.dataKey === 'capacityTotal')?.value as number) ?? 0;
                const clusterRows = clusters.map((c) => {
                  const value =
                    (payload.find((p) => p.dataKey === c.clusterId)?.value as number) ?? 0;
                  return { ...c, value };
                });
                const total = clusterRows.reduce((sum, r) => sum + r.value, 0);
                return (
                  <div className="rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md">
                    <div className="font-medium">{formatMonth(label)}</div>
                    <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                      {clusterRows.map((r, idx) => (
                        <React.Fragment key={r.clusterId}>
                          <dt className="flex items-center gap-1.5 text-muted-foreground">
                            <span
                              aria-hidden
                              className="h-2 w-2 rounded-full"
                              style={{
                                background:
                                  colors.clusterPalette[idx % colors.clusterPalette.length],
                              }}
                            />
                            {r.clusterName}
                          </dt>
                          <dd className="text-right font-mono tabular-nums">
                            {numberFormat.format(r.value)}
                          </dd>
                        </React.Fragment>
                      ))}
                      <dt className="mt-1 border-t border-border pt-1 text-muted-foreground">
                        Fleet total
                      </dt>
                      <dd className="mt-1 border-t border-border pt-1 text-right font-mono tabular-nums">
                        {numberFormat.format(total)} GB
                      </dd>
                      <dt className="text-muted-foreground">Capacity ceiling</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {numberFormat.format(capacity)} GB
                      </dd>
                    </dl>
                  </div>
                );
              }}
            />
            {clusters.map((c, idx) => (
              <Area
                key={c.clusterId}
                type="monotone"
                stackId="fleet"
                dataKey={c.clusterId}
                name={c.clusterName}
                stroke={colors.clusterPalette[idx % colors.clusterPalette.length]}
                fill={colors.clusterPalette[idx % colors.clusterPalette.length]}
                fillOpacity={0.6}
                isAnimationActive={false}
              />
            ))}
            <Line
              type="stepAfter"
              dataKey="capacityTotal"
              name="Capacity ceiling"
              stroke={colors.capacity}
              strokeWidth={1.75}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <FleetChartLegend clusters={clusters} />
    </div>
  );
}

function FleetChartLegend({ clusters }: { clusters: ClusterMeta[] }): React.JSX.Element {
  const colors = useChartColors();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      {clusters.map((c, idx) => (
        <span key={c.clusterId} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{ background: colors.clusterPalette[idx % colors.clusterPalette.length] }}
          />
          <span>{c.clusterName}</span>
        </span>
      ))}
      <span aria-hidden className="mx-1">
        ·
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="h-0 w-4 border-t-2 border-dashed"
          style={{ borderColor: colors.capacity }}
        />
        <span>Capacity ceiling</span>
      </span>
    </div>
  );
}
