import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { useChartColors } from '@/lib/use-chart-colors';
import { useEffectiveThresholds } from '@/lib/use-effective-thresholds';
import { cn } from '@/lib/utils';

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
  compact?: boolean;
}

const numberFormat = new Intl.NumberFormat('en-US');

function formatMonth(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

export function FleetCapacityChart({
  fleetMonths,
  clusters,
  compact = false,
}: FleetCapacityChartProps): React.JSX.Element {
  const colors = useChartColors();
  const effectiveThresholds = useEffectiveThresholds();
  const [focusedCluster, setFocusedCluster] = React.useState<string | null>(null);

  const enrichedRows = fleetMonths.map((row) => {
    const consumed = clusters.reduce((sum, c) => {
      const v = row[c.clusterId];
      return sum + (typeof v === 'number' ? v : 0);
    }, 0);
    return { ...row, headroom: Math.max(0, row.capacityTotal - consumed) };
  });
  const maxCeiling = enrichedRows.reduce((max, r) => Math.max(max, r.capacityTotal), 0);
  const ceilingForDomain = maxCeiling > 0 ? maxCeiling * 1.05 : undefined;

  return (
    <div className="w-full">
      <div className="h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={enrichedRows}
            margin={{ top: 12, right: compact ? 16 : 56, bottom: 0, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
            <XAxis
              dataKey="month"
              tickFormatter={formatMonth}
              tick={{ fontSize: compact ? 10 : 11 }}
              stroke={colors.axis}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis
              tick={{ fontSize: compact ? 10 : 11 }}
              stroke={colors.axis}
              tickFormatter={(v: number) => numberFormat.format(v)}
              domain={ceilingForDomain ? [0, ceilingForDomain] : ['auto', 'auto']}
              label={{
                value: 'GB',
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: compact ? 10 : 11, fill: colors.axis },
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
                  <div className="rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-[var(--overlay-shadow)]">
                    <div className="font-medium">{formatMonth(label)}</div>
                    <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                      {clusterRows.map((r, idx) => {
                        const isFocused = focusedCluster === r.clusterId;
                        const swatchColor = isFocused
                          ? colors.consumption
                          : colors.clusterPalette[idx % colors.clusterPalette.length];
                        return (
                          <React.Fragment key={r.clusterId}>
                            <dt
                              className={cn(
                                'flex items-center gap-1.5 text-muted-foreground',
                                isFocused && 'text-foreground',
                              )}
                            >
                              <span
                                aria-hidden
                                className="h-2 w-2 rounded-full"
                                style={{ background: swatchColor }}
                              />
                              {r.clusterName}
                            </dt>
                            <dd
                              className={cn(
                                'text-right font-mono tabular-nums',
                                isFocused && 'font-semibold text-foreground',
                              )}
                            >
                              {numberFormat.format(r.value)}
                            </dd>
                          </React.Fragment>
                        );
                      })}
                      <dt className="text-muted-foreground">Headroom</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {numberFormat.format(
                          (payload.find((p) => p.dataKey === 'headroom')?.value as number) ?? 0,
                        )}{' '}
                        GB
                      </dd>
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
            {clusters.map((c, idx) => {
              const isFocused = focusedCluster === c.clusterId;
              const isDimmed = focusedCluster !== null && !isFocused;
              const baseColor = colors.clusterPalette[idx % colors.clusterPalette.length];
              const stroke = isFocused ? colors.consumption : baseColor;
              const fill = isFocused ? colors.consumption : baseColor;
              return (
                <Area
                  key={c.clusterId}
                  type="monotone"
                  stackId="fleet"
                  dataKey={c.clusterId}
                  name={c.clusterName}
                  stroke={stroke}
                  strokeWidth={isFocused ? 2.5 : 1.5}
                  fill={fill}
                  fillOpacity={isFocused ? 0.75 : isDimmed ? 0.25 : 0.6}
                  isAnimationActive={false}
                  onMouseEnter={() => setFocusedCluster(c.clusterId)}
                  onMouseLeave={() => setFocusedCluster(null)}
                />
              );
            })}
            {maxCeiling > 0 ? (
              <Area
                type="monotone"
                dataKey="headroom"
                name="Headroom"
                stackId="fleet"
                stroke={colors.capacity}
                strokeDasharray="2 3"
                strokeOpacity={0.6}
                fill={colors.capacity}
                fillOpacity={0.08}
                isAnimationActive={false}
              />
            ) : null}
            {maxCeiling > 0 ? (
              <ReferenceLine
                y={maxCeiling * effectiveThresholds.warn}
                stroke={colors.utilizationWarn}
                strokeDasharray="2 2"
                {...(!compact && {
                  label: {
                    value: `Warn ${Math.round(effectiveThresholds.warn * 100)}%`,
                    position: 'right' as const,
                    fontSize: 10,
                    fill: colors.utilizationWarn,
                  },
                })}
              />
            ) : null}
            {maxCeiling > 0 ? (
              <ReferenceLine
                y={maxCeiling * effectiveThresholds.crit}
                stroke={colors.utilizationCrit}
                strokeDasharray="2 2"
                {...(!compact && {
                  label: {
                    value: `Crit ${Math.round(effectiveThresholds.crit * 100)}%`,
                    position: 'right' as const,
                    fontSize: 10,
                    fill: colors.utilizationCrit,
                  },
                })}
              />
            ) : null}
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
      <FleetChartLegend
        clusters={clusters}
        focusedCluster={focusedCluster}
        onFocus={setFocusedCluster}
      />
    </div>
  );
}

function FleetChartLegend({
  clusters,
  focusedCluster,
  onFocus,
}: {
  clusters: ClusterMeta[];
  focusedCluster: string | null;
  onFocus: (id: string | null) => void;
}): React.JSX.Element {
  const colors = useChartColors();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      {clusters.map((c, idx) => {
        const isFocused = focusedCluster === c.clusterId;
        const isDimmed = focusedCluster !== null && !isFocused;
        const baseColor = colors.clusterPalette[idx % colors.clusterPalette.length];
        const swatchColor = isFocused ? colors.consumption : baseColor;
        return (
          <span
            key={c.clusterId}
            className={cn(
              'flex cursor-default items-center gap-1.5 transition-opacity',
              isDimmed && 'opacity-50',
            )}
            onMouseEnter={() => onFocus(c.clusterId)}
            onMouseLeave={() => onFocus(null)}
            onFocus={() => onFocus(c.clusterId)}
            onBlur={() => onFocus(null)}
            tabIndex={0}
          >
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ background: swatchColor }}
            />
            <span className={cn(isFocused && 'text-foreground')}>{c.clusterName}</span>
          </span>
        );
      })}
      <span aria-hidden className="mx-1">
        ·
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="h-0 w-4 border-t-2 border-dashed"
          style={{ borderColor: colors.capacity, opacity: 0.5 }}
        />
        <span>Headroom</span>
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
