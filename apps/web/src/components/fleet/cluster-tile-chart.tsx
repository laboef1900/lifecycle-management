import type { ForecastMonthPoint } from '@lcm/shared';
import { useId } from 'react';
import {
  Area,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { autoScaleDomain } from '@/lib/chart-scale';
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
 * Per-tile y-window (#268, spec §4.4 amended 2026-07-20). Each tile scales to
 * its OWN data so the consumption line is vertically centred and uses the full
 * plot height.
 *
 * @ai-warning This deliberately reversed the long-standing "fixed window,
 * identical across all tiles" invariant (originally 0-125 %, tightened to
 * 40-125 % by #224). Two clusters at very different utilizations now draw the
 * same line shape, so the y-axis TICK LABELS are the only per-tile cue to
 * where on the scale a tile actually sits — they are load-bearing, not
 * decoration, and must never be hidden to save space.
 */
const SCALE_OPTIONS = { minSpan: 12, padRatio: 0.18, floor: 0, targetTicks: 3 };
const X_AXIS_HEIGHT = 16;
const Y_AXIS_WIDTH = 34;

/** Dash pattern for a threshold hairline drawn at its true value. */
const HAIRLINE_DASH = '4 3';
/**
 * Dash pattern for a hairline that had to be clamped to a window edge — the
 * "off-scale" cue. Without it a warn threshold of 90 % pinned to the top of a
 * 60-75 % window is indistinguishable from one genuinely configured at 75 %.
 * Pattern (not color) carries the distinction so it survives color-vision
 * deficiency, and the aria-label announces the true percentage either way.
 *
 * Under the retired fixed window this fired rarely (only for thresholds
 * configured outside 40-125 %). With a per-tile domain it is the NORMAL case:
 * a healthy cluster's window sits well below crit.
 */
const OFF_SCALE_DASH = '1 2';
/** Dash for the 100 %-capacity ceiling — distinct from both hairline dashes. */
const CAPACITY_DASH = '2 3';

interface TileChartRow {
  month: string;
  /**
   * True utilization % for this month — the canonical value, and the only
   * field present on EVERY row (`actual`/`forecast` are null outside their
   * segment). The tooltip reads this.
   */
  util: number;
  /** Utilization % for months at/before "now" — null elsewhere so the line stops. */
  actual: number | null;
  /** Utilization % for months at/after "now" (drawn dashed) — null elsewhere. */
  forecast: number | null;
}

interface Hairline {
  key: string;
  /** Plotted y, clamped into the tile's window. */
  y: number;
  /** True when the clamp bit — the line is NOT at its configured value. */
  offScale: boolean;
  stroke: string;
  dash: string;
  /**
   * Higher wins when two lines resolve to the same plotted y. Crit outranks
   * warn outranks the capacity ceiling: the more severe threshold is the one
   * a purchasing decision hinges on.
   */
  severity: number;
}

/**
 * Compact per-tile forecast chart: %-of-capacity on a window fitted to this
 * cluster's own data (see {@link SCALE_OPTIONS}), so the consumption line is
 * centred and fills the plot. The line is split into a solid "actual" segment
 * up to the current month and a dashed "forecast" segment from the current
 * month on — sharing the anchor point at the current month keeps the line
 * visually continuous.
 *
 * Because the domain is derived from the data, no data row can fall outside it
 * — the clamping and off-scale marking that the fixed window needed for the
 * data series are gone. Threshold hairlines still clamp, because a threshold
 * is configuration rather than data and routinely sits outside a healthy
 * cluster's window.
 */
export function ClusterTileChart({
  months,
  thresholds,
  orderByDate,
}: ClusterTileChartProps): React.JSX.Element | null {
  const colors = useChartColors();
  // A tile-instance-unique gradient id: the fleet grid renders many tiles at
  // once, each its own <svg> root, and a shared literal id would duplicate
  // across the document (invalid HTML, and `url(#id)` resolution across
  // duplicates is undefined). Colons stripped since `url(#id)` fragment refs
  // are safest as plain tokens.
  const gradientId = `tile-consumption-${useId().replace(/:/g, '')}`;
  if (months.length === 0) return null;

  const currentMonth = todayIso();
  const foundIndex = months.findIndex((m) => m.month === currentMonth);
  const currentIndex = foundIndex === -1 ? 0 : foundIndex;
  // Unlike ForecastChart (which gets leading `preWindow` rows from baseline
  // history so "now" can land mid-series), a tile's `months` is always the
  // raw forecast window, which always opens at the current month — so
  // `foundIndex` is 0 on every real tile. Render whenever "now" is in the
  // series; `order-by-rail.tsx` (spec §4.2) likewise draws NOW at the left
  // edge of its window as the normal case, not an edge case to hide.
  const showNowMarker = foundIndex >= 0;

  const utilPct = (m: ForecastMonthPoint): number =>
    m.capacity > 0 ? (m.consumption / m.capacity) * 100 : 0;

  const data: TileChartRow[] = months.map((m, i) => {
    const value = utilPct(m);
    return {
      month: m.month,
      util: value,
      actual: i <= currentIndex ? value : null,
      forecast: i >= currentIndex ? value : null,
    };
  });

  const scale = autoScaleDomain(
    data.map((r) => r.util),
    SCALE_OPTIONS,
  );
  const clampToWindow = (value: number): number => Math.min(Math.max(value, scale.min), scale.max);

  const warnPct = thresholds.warn * 100;
  const critPct = thresholds.crit * 100;

  // Build every horizontal reference line through one clamp, then collapse any
  // that land on the same plotted y. Two coincident lines render exactly on top
  // of each other, hiding the lower-severity one permanently while still
  // implying two distinguishable bands the scale cannot show. Under the old
  // fixed window only warn/crit could collide; with a per-tile domain the
  // capacity ceiling joins them (a healthy cluster's window clamps warn, crit
  // AND 100 % to the same top edge), so the merge is generalised rather than
  // special-cased to that one pair.
  const candidates: Array<Omit<Hairline, 'y' | 'offScale'> & { pct: number }> = [
    {
      key: 'capacity',
      pct: 100,
      stroke: colors.capacity,
      dash: CAPACITY_DASH,
      severity: 0,
    },
    {
      key: 'warn',
      pct: warnPct,
      stroke: colors.utilizationWarn,
      dash: HAIRLINE_DASH,
      severity: 1,
    },
    {
      key: 'crit',
      pct: critPct,
      stroke: colors.utilizationCrit,
      dash: HAIRLINE_DASH,
      severity: 2,
    },
  ];

  const byY = new Map<number, Hairline>();
  for (const c of candidates) {
    const y = clampToWindow(c.pct);
    const offScale = y !== c.pct;
    const line: Hairline = {
      key: c.key,
      y,
      offScale,
      stroke: c.stroke,
      // A clamped line is marked off-scale whatever its role, including the
      // capacity ceiling — a "100 %" line pinned at 78 % would otherwise read
      // as a capacity ceiling of 78 %.
      dash: offScale ? OFF_SCALE_DASH : c.dash,
      severity: c.severity,
    };
    const existing = byY.get(y);
    if (!existing || line.severity > existing.severity) byY.set(y, line);
  }
  const hairlines = [...byY.values()];

  const warnOffScale = clampToWindow(warnPct) !== warnPct;
  const critOffScale = clampToWindow(critPct) !== critPct;

  const breachIndex = months.findIndex(
    (m) => m.capacity > 0 && m.consumption / m.capacity >= thresholds.warn,
  );
  const breachRow = breachIndex >= 0 ? data[breachIndex] : undefined;

  const orderByMonthKey = orderByDate ? `${orderByDate.slice(0, 7)}-01` : null;
  const orderByInRange = orderByMonthKey ? months.some((m) => m.month === orderByMonthKey) : false;

  return (
    <div
      className="h-[168px] w-full"
      role="img"
      aria-label={chartAriaLabel({
        months,
        thresholds,
        breachIndex,
        orderByDate,
        scale,
        warnOffScale,
        critOffScale,
      })}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.consumption} stopOpacity={0.35} />
              <stop offset="100%" stopColor={colors.consumption} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          {/* No CartesianGrid here (#243 Part B): the y-axis tick labels already
              carry the reference, and the warn/crit/capacity hairlines below are
              the only lines that should read as a reference — a horizontal grid
              competed with them for attention on an already-small tile. */}
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
            domain={[scale.min, scale.max]}
            ticks={scale.ticks}
            // Keep the COMPUTED window exactly as computed. The reason changed
            // with #268 — it is no longer about cross-tile comparability but
            // about centring: letting Recharts widen the domain to its own
            // rounding would drift the line off the middle of the plot, which
            // is the whole point of the per-tile scale.
            allowDataOverflow
            tickFormatter={(v: number) => `${Math.round(v)}%`}
            tick={{ fontSize: 9, fill: 'var(--fg-subtle)' }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0 || typeof label !== 'string') {
                return null;
              }
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
          {/* Low-opacity fill under the line (#243 Part B) — mirrors the big
              ForecastChart's gradient area device so the consumption series
              reads as the primary mark rather than just another hairline.
              Two Areas (not one) so the fill follows the same solid/dashed
              split as the strokes below; both draw before the hairlines so
              the thresholds stay crisp on top of the tint. */}
          <Area
            type="monotone"
            dataKey="actual"
            stroke="none"
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Area
            type="monotone"
            dataKey="forecast"
            stroke="none"
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            connectNulls={false}
          />
          {/* Clamped into the window above. Recharts' ReferenceLine defaults to
              ifOverflow="discard", so an out-of-window threshold would render
              NOTHING — leaving a tile whose aria-label names a threshold it
              never draws. Pinning to the edge keeps the tile self-consistent;
              OFF_SCALE_DASH marks it as pinned rather than measured. */}
          {hairlines.map((line) => (
            <ReferenceLine
              key={line.key}
              y={line.y}
              stroke={line.stroke}
              strokeDasharray={line.dash}
            />
          ))}
          {showNowMarker ? (
            <ReferenceLine x={currentMonth} stroke="var(--steel)" strokeDasharray="2 3" />
          ) : null}
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
            // breach as a crit one (PR review fix 4a). No clamp: the dot sits
            // on a data value, and the domain contains all data by
            // construction.
            <ReferenceDot
              x={breachRow.month}
              y={breachRow.util}
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

function chartAriaLabel({
  months,
  thresholds,
  breachIndex,
  orderByDate,
  scale,
  warnOffScale,
  critOffScale,
}: {
  months: ForecastMonthPoint[];
  thresholds: { warn: number; crit: number };
  breachIndex: number;
  orderByDate: string | null;
  scale: { min: number; max: number };
  warnOffScale: boolean;
  critOffScale: boolean;
}): string {
  const parts = [
    // #268: this sentence used to promise a "shared 40 to 125 percent scale
    // across tiles". The scale is per-tile now, and saying so is the only way
    // a non-sighted reader knows the axis differs from the tile next to it.
    `${months.length}-month forecast as percent of capacity, scaled to this cluster's own range, ${Math.round(scale.min)} to ${Math.round(scale.max)} percent.`,
  ];
  parts.push(
    breachIndex >= 0
      ? `Warn breach about ${formatMonthShort(months[breachIndex]!.month)}.`
      : 'No breach within the window.',
  );
  if (orderByDate) parts.push(`Order by ${orderByDate}.`);
  // The visible hairline for an off-scale threshold is pinned to a window edge,
  // so the spoken percentage is the only place its true value survives.
  parts.push(
    `Warn threshold ${Math.round(thresholds.warn * 100)} percent${
      warnOffScale ? ', outside the visible range' : ''
    }.`,
  );
  parts.push(
    `Critical threshold ${Math.round(thresholds.crit * 100)} percent${
      critOffScale ? ', outside the visible range' : ''
    }.`,
  );
  return parts.join(' ');
}
