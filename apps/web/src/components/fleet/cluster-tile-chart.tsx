import type { ForecastMonthPoint } from '@lcm/shared';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { todayIso } from '@/lib/format';
import { formatMonthShort } from '@/lib/format-month';
import { useChartColors } from '@/lib/use-chart-colors';

export interface ClusterTileChartProps {
  months: ForecastMonthPoint[];
  thresholds: { warn: number; crit: number };
  /** Full `YYYY-MM-DD` procurement order-by date, or null when no order is needed. */
  orderByDate: string | null;
}

/** Shared %-of-capacity ceiling across every tile so tiles are visually comparable (spec §4.4). */
const Y_MAX = 125;

interface TileChartRow {
  month: string;
  /** Utilization % for months at/before "now" — null elsewhere so the line stops. */
  actual: number | null;
  /** Utilization % for months at/after "now" (drawn dashed) — null elsewhere. */
  forecast: number | null;
}

/**
 * Compact per-tile forecast chart: %-of-capacity on a fixed 0-125 scale so
 * every tile in the grid is visually comparable. The consumption line is
 * split into a solid "actual" segment up to the current month and a dashed
 * "forecast" segment from the current month on — sharing the anchor point at
 * the current month keeps the line visually continuous.
 */
export function ClusterTileChart({
  months,
  thresholds,
  orderByDate,
}: ClusterTileChartProps): React.JSX.Element | null {
  const colors = useChartColors();
  if (months.length === 0) return null;

  const currentMonth = todayIso();
  const foundIndex = months.findIndex((m) => m.month === currentMonth);
  const currentIndex = foundIndex === -1 ? 0 : foundIndex;

  const utilPct = (m: ForecastMonthPoint): number =>
    m.capacity > 0 ? (m.consumption / m.capacity) * 100 : 0;

  const data: TileChartRow[] = months.map((m, i) => {
    const value = utilPct(m);
    return {
      month: m.month,
      actual: i <= currentIndex ? value : null,
      forecast: i >= currentIndex ? value : null,
    };
  });

  const warnPct = thresholds.warn * 100;
  const critPct = thresholds.crit * 100;

  const breachIndex = months.findIndex(
    (m) => m.capacity > 0 && m.consumption / m.capacity >= thresholds.warn,
  );
  const breachRow = breachIndex >= 0 ? data[breachIndex] : undefined;

  const orderByMonthKey = orderByDate ? `${orderByDate.slice(0, 7)}-01` : null;
  const orderByInRange = orderByMonthKey ? months.some((m) => m.month === orderByMonthKey) : false;

  return (
    <div
      className="h-[130px] w-full"
      role="img"
      aria-label={chartAriaLabel(months, thresholds, breachIndex, orderByDate)}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 8, bottom: 2, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
          <XAxis dataKey="month" hide />
          <YAxis domain={[0, Y_MAX]} hide />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0 || typeof label !== 'string') {
                return null;
              }
              const value = (payload[0]?.value as number | null) ?? null;
              return (
                <div className="rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-[var(--overlay-shadow)]">
                  <span className="font-medium">{formatMonthShort(label)}</span>
                  {value !== null ? (
                    <span className="ml-2 font-mono tabular-nums">{value.toFixed(1)}%</span>
                  ) : null}
                </div>
              );
            }}
          />
          <ReferenceLine y={warnPct} stroke={colors.utilizationWarn} strokeDasharray="4 3" />
          <ReferenceLine y={critPct} stroke={colors.utilizationCrit} strokeDasharray="4 3" />
          <ReferenceLine y={100} stroke={colors.capacity} strokeDasharray="2 3" />
          {orderByInRange && orderByMonthKey ? (
            <ReferenceLine
              x={orderByMonthKey}
              stroke="var(--steel)"
              strokeDasharray="5 4"
              label={{
                value: 'ORDER BY',
                position: 'insideTopLeft',
                fontSize: 8,
                fill: 'var(--steel)',
                // Halo so the label stays legible where it crosses the line/grid (spec §6).
                style: { paintOrder: 'stroke', stroke: 'var(--card)', strokeWidth: 3 },
              }}
            />
          ) : null}
          <Line
            type="monotone"
            dataKey="actual"
            stroke={colors.consumption}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="forecast"
            stroke={colors.consumption}
            strokeWidth={1.75}
            strokeDasharray="6 4"
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          {breachRow ? (
            <ReferenceDot
              x={breachRow.month}
              y={Math.min(breachRow.actual ?? breachRow.forecast ?? 0, Y_MAX)}
              r={4}
              fill={colors.utilizationCrit}
              stroke="var(--card)"
              strokeWidth={1.5}
              label={{
                value: `BREACH ${formatMonthShort(breachRow.month).toUpperCase()}`,
                position: 'top',
                fontSize: 8,
                fill: colors.utilizationCrit,
                style: { paintOrder: 'stroke', stroke: 'var(--card)', strokeWidth: 3 },
              }}
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function chartAriaLabel(
  months: ForecastMonthPoint[],
  thresholds: { warn: number; crit: number },
  breachIndex: number,
  orderByDate: string | null,
): string {
  const parts = [
    `${months.length}-month forecast as percent of capacity, shared scale across tiles.`,
  ];
  parts.push(
    breachIndex >= 0
      ? `Warn breach about ${formatMonthShort(months[breachIndex]!.month)}.`
      : 'No breach within the window.',
  );
  if (orderByDate) parts.push(`Order by ${orderByDate}.`);
  parts.push(`Warn threshold ${Math.round(thresholds.warn * 100)} percent.`);
  parts.push(`Critical threshold ${Math.round(thresholds.crit * 100)} percent.`);
  return parts.join(' ');
}
