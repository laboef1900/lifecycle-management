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

/**
 * Shared %-of-capacity window across every tile so tiles are visually comparable
 * (spec §4.4, amended 2026-07-18). The floor is 40 %, not 0 %: real clusters of
 * interest sit well above 40 %, so the old 0–125 scale spent its bottom third
 * empty and squeezed the warn/crit band into a top sliver. The window is FIXED
 * (see `allowDataOverflow` on the YAxis) — values outside it are clamped, never
 * allowed to stretch the axis, or the shared scale would stop being shared.
 */
const Y_MIN = 40;
const Y_MAX = 125;
const Y_TICKS = [50, 75, 100];
const X_AXIS_HEIGHT = 16;
const Y_AXIS_WIDTH = 30;

/** Clamp a utilization % into the fixed shared window so it can't stretch the axis. */
const clampToWindow = (value: number): number => Math.min(Math.max(value, Y_MIN), Y_MAX);

interface TileChartRow {
  month: string;
  /**
   * True utilization % for this month — always present (0 for unknown/zero
   * capacity). The tooltip reports this so it stays honest even when the plotted
   * line is clamped to the window edge.
   */
  util: number;
  /** Clamped utilization % for months at/before "now" — null elsewhere so the line stops. */
  actual: number | null;
  /** Clamped utilization % for months at/after "now" (drawn dashed) — null elsewhere. */
  forecast: number | null;
}

/**
 * Compact per-tile forecast chart: %-of-capacity on the fixed shared window
 * (40-125 % — see the `Y_MIN`/`Y_MAX` block above, which is the single source
 * of truth) so every tile in the grid is visually comparable. Values outside
 * the window — data rows, the breach dot, and the warn/crit hairlines alike —
 * are clamped to its edges rather than allowed to stretch the axis or vanish.
 * The consumption line is
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
    const plotted = clampToWindow(value);
    return {
      month: m.month,
      util: value,
      actual: i <= currentIndex ? plotted : null,
      forecast: i >= currentIndex ? plotted : null,
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
        <ComposedChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
          <XAxis
            dataKey="month"
            height={X_AXIS_HEIGHT}
            tickFormatter={formatMonthShort}
            // Recharts paints tick text from `fill`; `colors.axis` is tuned as a
            // ~1.4:1 line color, unfit as label text — use the --fg-subtle text
            // token while the axis line itself keeps colors.grid.
            tick={{ fontSize: 9, fill: 'var(--fg-subtle)' }}
            tickLine={false}
            stroke={colors.grid}
            interval="preserveStartEnd"
            minTickGap={28}
          />
          <YAxis
            width={Y_AXIS_WIDTH}
            domain={[Y_MIN, Y_MAX]}
            ticks={Y_TICKS}
            // Keep the shared window fixed: never let below-floor (0 %, unknown
            // capacity) or above-ceiling (>125 %) data stretch the axis, or tiles
            // would stop being comparable at a glance.
            allowDataOverflow
            tickFormatter={(v: number) => `${v}%`}
            tick={{ fontSize: 9, fill: 'var(--fg-subtle)' }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0 || typeof label !== 'string') {
                return null;
              }
              // Report the TRUE utilization, not the clamped plotted value.
              const row = payload[0]?.payload as TileChartRow | undefined;
              const value = row ? row.util : null;
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
          {/* Clamp the hairlines into the window. Recharts' ReferenceLine
              defaults to ifOverflow="discard", so a threshold configured below
              the 40 % floor (percentSchema allows 0.01) would render NOTHING —
              yet the breach dot still pins to the floor and the aria-label
              still names the threshold, an inconsistent, misleading tile.
              Pinning the hairline to the floor instead keeps the tile
              self-consistent and stays honest: the whole visible window is
              then genuinely at or above warn. The aria-label keeps reporting
              the true percentage. */}
          <ReferenceLine
            y={clampToWindow(warnPct)}
            stroke={colors.utilizationWarn}
            strokeDasharray="4 3"
          />
          <ReferenceLine
            y={clampToWindow(critPct)}
            stroke={colors.utilizationCrit}
            strokeDasharray="4 3"
          />
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
            // Positioned at the WARN-threshold crossing (breachIndex above
            // uses thresholds.warn, not crit), so it must render in the warn
            // color — filling it with utilizationCrit mislabeled a warn
            // breach as a crit one (PR review fix 4a).
            <ReferenceDot
              x={breachRow.month}
              // Clamp into the fixed window on BOTH ends. The upper clamp keeps a
              // >125 % breach on-chart; the lower clamp only bites if the warn
              // threshold is configured below the 40 % floor (breach y ≥ warnPct).
              y={clampToWindow(breachRow.util)}
              r={4}
              fill={colors.utilizationWarn}
              stroke="var(--card)"
              strokeWidth={1.5}
              label={{
                value: `BREACH ${formatMonthShort(breachRow.month).toUpperCase()}`,
                position: 'top',
                fontSize: 8,
                fill: colors.utilizationWarn,
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
    `${months.length}-month forecast as percent of capacity, shared ${Y_MIN} to ${Y_MAX} percent scale across tiles.`,
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
