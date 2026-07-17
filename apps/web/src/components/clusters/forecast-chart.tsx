import type { ForecastResponse } from '@lcm/shared';
import { useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card } from '@/components/ui/card';
import { todayIso } from '@/lib/format';
import { formatMonthShort } from '@/lib/format-month';
import { eventColor, useChartColors } from '@/lib/use-chart-colors';

import {
  CHART_HEIGHT,
  CHART_MARGIN,
  X_AXIS_HEIGHT,
  Y_AXIS_WIDTH,
  layoutEventLabel,
  planEventLabelOffsets,
  type EventLabelViewBox,
} from './forecast-label-layout';

interface ForecastChartProps {
  forecast: ForecastResponse;
  compact?: boolean;
  /**
   * Active what-if scenario (spec §5.4). When set, the scenario's forecast
   * becomes the primary consumption/capacity/threshold series and `forecast`
   * (the baseline) renders as a muted dashed "was: baseline" ghost.
   */
  scenario?: { label: string; forecast: ForecastResponse } | null;
  /** Delta callout rendered as text under the legend (e.g. "▲ warn 5 mo earlier"). */
  scenarioDeltaLabel?: string;
}

const numberFormat = new Intl.NumberFormat('en-US');

export function ForecastChart({
  forecast,
  compact = false,
  scenario,
  scenarioDeltaLabel,
}: ForecastChartProps): React.JSX.Element {
  const colors = useChartColors();
  // Measured SVG width from ResponsiveContainer; the event-label planner needs
  // it to resolve label collisions and clamp boxes in pixel space.
  const [chartWidth, setChartWidth] = useState<number | null>(null);
  // The scenario forecast (when active) drives every series — consumption,
  // capacity, thresholds, hosts, events — per spec §5.4; the baseline
  // `forecast` prop then only supplies the "was: baseline" ghost values.
  const activeForecast = scenario ? scenario.forecast : forecast;
  const { warn, crit } = activeForecast.effectiveThresholds;

  const baselineByMonth = new Map<string, number>();
  if (scenario) {
    for (const p of forecast.months) baselineByMonth.set(p.month, Math.round(p.consumption));
  }

  const currentMonth = todayIso();
  const foundCurrentIndex = activeForecast.months.findIndex((m) => m.month === currentMonth);
  const currentIndex = foundCurrentIndex === -1 ? 0 : foundCurrentIndex;

  // Measured baselines, keyed by month. These are the ACTUALS behind the modelled
  // line — the trend that actually drives purchasing decisions.
  const measuredByMonth = new Map<string, number>();
  for (const h of activeForecast.baselineHistory) {
    measuredByMonth.set(h.capturedAt, Math.round(h.consumption));
  }

  // History predating the forecast window gets its own leading rows: the window
  // opens at the NEWEST baseline, so without these every older measurement would
  // be invisible — which is precisely what #172 exists to fix.
  const preWindow = activeForecast.baselineHistory
    .filter((h) => h.capturedAt < activeForecast.fromMonth)
    .map((h) => ({
      month: h.capturedAt,
      consumption: Math.round(h.consumption),
      actual: null,
      forecast: null,
      headroom: null,
      capacity: null,
      warnLevel: null,
      critLevel: null,
      baselineConsumption: null,
      measured: Math.round(h.consumption),
    }));

  const windowData = activeForecast.months.map((point, index) => {
    const capacity = Math.round(point.capacity);
    const consumption = Math.round(point.consumption);
    return {
      month: point.month,
      consumption,
      // Solid up to "now", dashed from "now" on — same split-series approach
      // as the fleet tile chart, sharing the current-month anchor point.
      actual: index <= currentIndex ? consumption : null,
      forecast: index >= currentIndex ? consumption : null,
      headroom: Math.max(0, capacity - consumption),
      capacity,
      warnLevel: Math.round(capacity * warn),
      critLevel: Math.round(capacity * crit),
      baselineConsumption: scenario ? (baselineByMonth.get(point.month) ?? null) : null,
      // null (not 0) for months with no measurement — see the `measured` <Line>.
      measured: measuredByMonth.get(point.month) ?? null,
    };
  });

  const data = [...preWindow, ...windowData];
  const maxCeiling = data.reduce((max, d) => Math.max(max, d.capacity ?? 0), 0);
  const ceilingForDomain = maxCeiling > 0 ? maxCeiling * 1.05 : undefined;
  const lastIndex = data.length - 1;

  const eventsByMonth = new Map<string, ForecastResponse['events']>();
  for (const event of activeForecast.events) {
    const monthKey = `${event.effectiveDate.slice(0, 7)}-01`;
    const bucket = eventsByMonth.get(monthKey) ?? [];
    bucket.push(event);
    eventsByMonth.set(monthKey, bucket);
  }

  const monthIndexByKey = new Map(data.map((d, index) => [d.month, index]));
  // Events whose month falls inside the visible window — these render a dot
  // and a boxed label on the chart.
  const eventDots = activeForecast.events.flatMap((event) => {
    const monthKey = `${event.effectiveDate.slice(0, 7)}-01`;
    const monthIndex = monthIndexByKey.get(monthKey);
    const datum = monthIndex === undefined ? undefined : data[monthIndex];
    if (monthIndex === undefined || datum === undefined) return [];
    return [{ event, monthKey, monthIndex, consumption: datum.consumption }];
  });
  const eventLabelOffsets = planEventLabelOffsets({
    events: eventDots.map(({ event, monthIndex }) => ({ id: event.id, monthIndex })),
    monthCount: data.length,
    chartWidth,
    compact,
  });

  // Earliest projected end-of-life across all hosts in this forecast. The
  // chart X-axis is categorical (month strings), so snap the EOL date to the
  // first day of its month and only render if that month is within the
  // visible window.
  const earliestEolHost = activeForecast.hosts
    .filter(
      (h): h is typeof h & { projectedDecommissionAt: string } =>
        typeof h.projectedDecommissionAt === 'string' && h.projectedDecommissionAt.length > 0,
    )
    .sort((a, b) => a.projectedDecommissionAt.localeCompare(b.projectedDecommissionAt))[0];
  const eolMonthKey = earliestEolHost
    ? `${earliestEolHost.projectedDecommissionAt.slice(0, 7)}-01`
    : null;
  const eolMonthInRange = eolMonthKey && data.some((d) => d.month === eolMonthKey);

  return (
    <Card className="p-4">
      {/* TODO(a11y): fold cluster/metric identity into this label before any multi-chart layout (PR 2 Radix rebuild). */}
      <div
        className="w-full"
        style={{ height: CHART_HEIGHT }}
        role="img"
        aria-label="Capacity forecast chart"
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          onResize={(width) => setChartWidth(width > 0 ? width : null)}
        >
          <ComposedChart
            data={data}
            margin={{
              top: CHART_MARGIN.top,
              right: compact ? CHART_MARGIN.rightCompact : CHART_MARGIN.right,
              bottom: CHART_MARGIN.bottom,
              left: CHART_MARGIN.left,
            }}
            accessibilityLayer={false}
          >
            <defs>
              <linearGradient id="forecast-consumption" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.consumption} stopOpacity={0.45} />
                <stop offset="100%" stopColor={colors.consumption} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
            <XAxis
              dataKey="month"
              height={X_AXIS_HEIGHT}
              tickFormatter={formatMonthShort}
              // Recharts paints tick text from `fill` (falling back to `stroke`
              // when unset) — `colors.axis` is tuned as a line color (~1.4:1 as
              // text on dark), so tick text needs the separate `--fg-subtle`
              // text token while the axis line itself keeps `colors.axis`.
              tick={{ fontSize: compact ? 10 : 11, fill: 'var(--fg-subtle)' }}
              stroke={colors.axis}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis
              width={Y_AXIS_WIDTH}
              tick={{ fontSize: compact ? 10 : 11, fill: 'var(--fg-subtle)' }}
              stroke={colors.axis}
              tickFormatter={(v: number) => numberFormat.format(v)}
              domain={ceilingForDomain ? [0, ceilingForDomain] : ['auto', 'auto']}
              label={{
                value: 'GB',
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: compact ? 10 : 11, fill: 'var(--fg-subtle)' },
              }}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0 || typeof label !== 'string') {
                  return null;
                }
                const consumption =
                  (payload.find((p) => p.dataKey === 'consumption')?.value as number) ?? 0;
                const headroom =
                  (payload.find((p) => p.dataKey === 'headroom')?.value as number) ?? 0;
                const capacity =
                  (payload.find((p) => p.dataKey === 'capacity')?.value as number) ??
                  consumption + headroom;
                const utilization = capacity > 0 ? (consumption / capacity) * 100 : 0;
                const monthEvents = eventsByMonth.get(label) ?? [];
                return (
                  <div className="rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-[var(--overlay-shadow)]">
                    <div className="font-medium">{formatMonthShort(label)}</div>
                    <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                      <dt className="text-fg-muted">Consumption</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {numberFormat.format(consumption)} GB
                      </dd>
                      <dt className="text-fg-muted">Capacity</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {numberFormat.format(capacity)} GB
                      </dd>
                      <dt className="text-fg-muted">Headroom</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {numberFormat.format(headroom)} GB
                      </dd>
                      <dt className="text-fg-muted">Utilization</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {utilization.toFixed(1)}%
                      </dd>
                    </dl>
                    {monthEvents.length > 0 ? (
                      <ul className="mt-2 space-y-1 border-t border-border pt-2">
                        {monthEvents.map((event) => (
                          <li key={event.id} className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className="h-2 w-2 rounded-full"
                              style={{ background: eventColor(colors, event.category) }}
                            />
                            <span className="flex-1 truncate">{event.title}</span>
                            <span className="font-mono tabular-nums text-fg-muted">
                              {formatDelta(event.consumptionDelta, event.capacityDelta)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="consumption"
              name="Consumption"
              stackId="capacity"
              stroke="none"
              fill="url(#forecast-consumption)"
              isAnimationActive={false}
            />
            {/* Measured baselines — the ACTUALS behind the modelled line, and the
                trend that actually drives purchasing. Drawn beneath the forecast
                series so the model reads as an overlay on reality.

                @ai-warning `connectNulls={false}` is load-bearing, not styling. A
                month with no baseline is an honest GAP — a snapshot that could not
                be taken — never a zero. Connecting across it would silently smooth
                a missing measurement into a continuous trend, turning "we don't
                know" into a fabricated fact on the series that buys hardware. */}
            <Line
              type="monotone"
              dataKey="measured"
              name="Measured"
              stroke={colors.consumption}
              strokeWidth={1.5}
              strokeOpacity={0.55}
              strokeDasharray="1 3"
              dot={{ r: 2.5, strokeWidth: 0, fill: colors.consumption }}
              isAnimationActive={false}
              connectNulls={false}
            />
            {/* Actual/forecast split (spec §5.4): solid up to "now", dashed from
                "now" on, sharing the current-month anchor point. Tracks the
                scenario forecast when one is active. */}
            <Line
              type="monotone"
              dataKey="actual"
              name="Consumption"
              stroke={colors.consumption}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="forecast"
              name="Consumption (forecast)"
              stroke={colors.consumption}
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
              legendType="none"
            />
            {maxCeiling > 0 ? (
              <Area
                type="monotone"
                dataKey="headroom"
                name="Headroom"
                stackId="capacity"
                stroke={colors.capacity}
                strokeDasharray="2 3"
                strokeOpacity={0.6}
                fill={colors.capacity}
                fillOpacity={0.08}
                isAnimationActive={false}
              />
            ) : null}
            {maxCeiling > 0 ? (
              <Line
                type="stepAfter"
                dataKey="warnLevel"
                name="Warn"
                stroke={colors.utilizationWarn}
                strokeWidth={1}
                strokeDasharray="2 2"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                legendType="none"
              >
                {!compact ? (
                  <LabelList
                    dataKey="warnLevel"
                    content={renderEndLabel(
                      lastIndex,
                      `Warn ${Math.round(warn * 100)}%`,
                      colors.utilizationWarn,
                    )}
                  />
                ) : null}
              </Line>
            ) : null}
            {maxCeiling > 0 ? (
              <Line
                type="stepAfter"
                dataKey="critLevel"
                name="Crit"
                stroke={colors.utilizationCrit}
                strokeWidth={1}
                strokeDasharray="2 2"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                legendType="none"
              >
                {!compact ? (
                  <LabelList
                    dataKey="critLevel"
                    content={renderEndLabel(
                      lastIndex,
                      `Crit ${Math.round(crit * 100)}%`,
                      colors.utilizationCrit,
                    )}
                  />
                ) : null}
              </Line>
            ) : null}
            <Line
              type="stepAfter"
              dataKey="capacity"
              name="Capacity"
              stroke={colors.capacity}
              strokeWidth={1.75}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
            />
            {scenario ? (
              <Line
                type="monotone"
                dataKey="baselineConsumption"
                name="was: baseline"
                stroke={colors.utilizationOk}
                strokeWidth={1.5}
                strokeDasharray="5 4"
                strokeOpacity={0.8}
                dot={false}
                activeDot={{ r: 3 }}
                isAnimationActive={false}
                connectNulls
              />
            ) : null}
            {eolMonthInRange && earliestEolHost ? (
              <ReferenceLine
                x={eolMonthKey ?? undefined}
                stroke={colors.utilizationWarn}
                strokeDasharray="4 4"
                ifOverflow="extendDomain"
                label={{
                  value: `EOL: ${earliestEolHost.name}`,
                  position: 'top',
                  fontSize: 11,
                  fill: colors.utilizationWarn,
                }}
              />
            ) : null}
            {eventDots.map(({ event, monthKey, consumption }) => (
              <ReferenceDot
                key={event.id}
                x={monthKey}
                y={consumption}
                r={5}
                fill={eventColor(colors, event.category)}
                stroke="var(--card)"
                strokeWidth={1.5}
                ifOverflow="extendDomain"
                label={renderEventLabel(
                  event.title,
                  eventColor(colors, event.category),
                  compact,
                  eventLabelOffsets.get(event.id) ?? 0,
                )}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <ChartLegend
        events={activeForecast.events}
        colors={colors}
        showBaselineGhost={Boolean(scenario)}
      />
      {scenarioDeltaLabel ? (
        <p
          data-testid="scenario-delta-label"
          className="mt-1 font-mono text-[11px] font-medium text-fg-muted"
        >
          {scenarioDeltaLabel}
        </p>
      ) : null}
    </Card>
  );
}

// Recharts calls a LabelList `content` render function with a broad, loosely
// typed props bag (its ImplicitLabelType). We only read index/x/y, so accept a
// minimal structural shape (all optional) and validate at runtime — no `any`.
interface EndLabelRenderProps {
  index?: number | undefined;
  x?: string | number | undefined;
  y?: string | number | undefined;
}

function renderEndLabel(lastIndex: number, text: string, fill: string) {
  return (props: EndLabelRenderProps): React.JSX.Element | null => {
    if (props.index !== lastIndex) return null;
    const numericX = Number(props.x);
    const numericY = Number(props.y);
    if (!Number.isFinite(numericX) || !Number.isFinite(numericY)) return null;
    return (
      <text x={numericX + 4} y={numericY} dy={3} fontSize={10} fill={fill}>
        {text}
      </text>
    );
  };
}

// Recharts invokes a function-valued ReferenceDot `label` with a loosely typed
// props bag whose `viewBox` is the dot's bounding box. Like EndLabelRenderProps
// above, we accept a minimal structural shape and validate at runtime — no `any`.
interface EventLabelRenderProps {
  viewBox?: EventLabelViewBox | undefined;
}

// Draws an event's title as vertical text in a category-coloured box below
// (or, when space below is tight, above) its dot, with a leader line back to
// the datapoint. The card fill keeps the text readable over the chart area;
// pointer events stay off so tooltip hover is unaffected.
function renderEventLabel(title: string, color: string, compact: boolean, offsetX: number) {
  return (props: EventLabelRenderProps): React.JSX.Element | null => {
    const geometry = layoutEventLabel(props.viewBox, { title, compact, offsetX });
    if (!geometry) return null;
    const { box, leader } = geometry;
    return (
      <g style={{ pointerEvents: 'none' }}>
        {/* The leader's dot-side end hides under the marker, so it reads as
            coming out of the point. */}
        <line
          x1={leader.x1}
          y1={leader.y1}
          x2={leader.x2}
          y2={leader.y2}
          stroke={color}
          strokeWidth={1}
          strokeOpacity={0.75}
        />
        <rect
          x={box.x}
          y={box.y}
          width={box.width}
          height={box.height}
          rx={3}
          fill="var(--card)"
          stroke={color}
          strokeWidth={1.25}
        />
        <text
          x={geometry.textX}
          y={geometry.textY}
          transform={`rotate(-90, ${geometry.textX}, ${geometry.textY})`}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={geometry.fontSize}
          fontWeight={600}
          fill={color}
        >
          {geometry.text}
        </text>
      </g>
    );
  };
}

function formatDelta(consumption: number | null, capacity: number | null): string {
  const parts: string[] = [];
  if (consumption !== null) {
    parts.push(`${consumption >= 0 ? '+' : ''}${numberFormat.format(consumption)} cons`);
  }
  if (capacity !== null) {
    parts.push(`${capacity >= 0 ? '+' : ''}${numberFormat.format(capacity)} cap`);
  }
  return parts.length === 0 ? '—' : parts.join(' · ');
}

interface ChartLegendProps {
  events: ForecastResponse['events'];
  colors: ReturnType<typeof useChartColors>;
  /** True when a scenario is active — adds the "was: baseline" ghost entry. */
  showBaselineGhost: boolean;
}

function ChartLegend({ events, colors, showBaselineGhost }: ChartLegendProps): React.JSX.Element {
  const categories = Array.from(new Set(events.map((e) => e.category)));
  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-fg-muted">
      <LegendItem swatch={colors.consumption} label="Consumption" />
      <LegendItem swatch={colors.capacity} label="Capacity ceiling" dashed />
      <LegendItem swatch={colors.capacity} label="Headroom" dashed faint />
      {showBaselineGhost ? (
        <LegendItem swatch={colors.utilizationOk} label="was: baseline" dashed />
      ) : null}
      {categories.length > 0 ? (
        <span aria-hidden className="mx-1">
          ·
        </span>
      ) : null}
      {categories.map((category) => (
        <LegendItem key={category} swatch={eventColor(colors, category)} label={category} dot />
      ))}
    </div>
  );
}

function LegendItem({
  swatch,
  label,
  dot,
  dashed,
  faint,
}: {
  swatch: string;
  label: string;
  dot?: boolean;
  dashed?: boolean;
  faint?: boolean;
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className={dot ? 'h-2 w-2 rounded-full' : 'h-0 w-4 border-t-2'}
        style={
          dot
            ? { background: swatch, opacity: faint ? 0.4 : 1 }
            : {
                borderColor: swatch,
                borderStyle: dashed ? 'dashed' : 'solid',
                opacity: faint ? 0.4 : 1,
              }
        }
      />
      <span>{label}</span>
    </span>
  );
}
