import type { EventCategory, ForecastResponse } from '@lcm/shared';
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
import { formatMonthShort } from '@/lib/format-month';
import { useChartColors } from '@/lib/use-chart-colors';

interface ForecastChartProps {
  forecast: ForecastResponse;
  compact?: boolean;
  /** Optional scenario overlay — consumption line drawn dashed on top of baseline. */
  scenario?: { label: string; months: ForecastResponse['months'] } | null;
}

const numberFormat = new Intl.NumberFormat('en-US');

// The chart canvas is a fixed 320px tall (see the `h-[320px]` wrapper below).
// Event labels are placed below their dot by default and flipped above when
// they'd otherwise overflow the plotting band, so we need the approximate top
// and bottom of that band in SVG coordinates. The bottom leaves room for the
// categorical x-axis (~recharts default height).
const CHART_HEIGHT = 320;
const CHART_PLOT_TOP = 12; // matches the ComposedChart top margin
const CHART_PLOT_BOTTOM = CHART_HEIGHT - 30; // leave room for the x-axis

export function ForecastChart({
  forecast,
  compact = false,
  scenario,
}: ForecastChartProps): React.JSX.Element {
  const colors = useChartColors();
  const { warn, crit } = forecast.effectiveThresholds;
  const scenarioByMonth = new Map<string, number>();
  if (scenario) {
    for (const p of scenario.months) scenarioByMonth.set(p.month, Math.round(p.consumption));
  }
  const data = forecast.months.map((point) => {
    const capacity = Math.round(point.capacity);
    return {
      month: point.month,
      consumption: Math.round(point.consumption),
      headroom: Math.max(0, Math.round(point.capacity - point.consumption)),
      capacity,
      warnLevel: Math.round(point.capacity * warn),
      critLevel: Math.round(point.capacity * crit),
      scenarioConsumption: scenarioByMonth.get(point.month) ?? null,
    };
  });
  const maxCeiling = data.reduce((max, d) => Math.max(max, d.capacity), 0);
  const ceilingForDomain = maxCeiling > 0 ? maxCeiling * 1.05 : undefined;
  const lastIndex = data.length - 1;

  const eventsByMonth = new Map<string, ForecastResponse['events']>();
  for (const event of forecast.events) {
    const monthKey = `${event.effectiveDate.slice(0, 7)}-01`;
    const bucket = eventsByMonth.get(monthKey) ?? [];
    bucket.push(event);
    eventsByMonth.set(monthKey, bucket);
  }

  // Vertical event labels share the same x as their dot, so multiple events in
  // one month would stack on top of each other. Spread each month's labels into
  // adjacent columns, centred over the dot, so their boxes stay clear of each
  // other (gap is a touch wider than the box so boxes never touch).
  const labelColumnGap = compact ? 22 : 24;
  const eventLabelOffset = new Map<string, number>();
  for (const bucket of eventsByMonth.values()) {
    const total = bucket.length;
    bucket.forEach((event, index) => {
      eventLabelOffset.set(event.id, (index - (total - 1) / 2) * labelColumnGap);
    });
  }

  // Earliest projected end-of-life across all hosts in this forecast. The
  // chart X-axis is categorical (month strings), so snap the EOL date to the
  // first day of its month and only render if that month is within the
  // visible window.
  const earliestEolHost = forecast.hosts
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
      <div className="h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 12, right: compact ? 16 : 56, bottom: 0, left: 8 }}
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
              tickFormatter={formatMonthShort}
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
                              style={{ background: colors.event[event.category] }}
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
              stroke={colors.consumption}
              strokeWidth={2}
              fill="url(#forecast-consumption)"
              isAnimationActive={false}
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
                dataKey="scenarioConsumption"
                name="Scenario"
                stroke={colors.consumption}
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
                activeDot={{ r: 3 }}
                isAnimationActive={false}
                connectNulls
              />
            ) : null}
            {eolMonthInRange && earliestEolHost ? (
              <ReferenceLine
                x={eolMonthKey ?? undefined}
                stroke="#d97706"
                strokeDasharray="4 4"
                ifOverflow="extendDomain"
                label={{
                  value: `EOL: ${earliestEolHost.name}`,
                  position: 'top',
                  fontSize: 11,
                  fill: '#b45309',
                }}
              />
            ) : null}
            {forecast.events.map((event) => {
              const monthKey = `${event.effectiveDate.slice(0, 7)}-01`;
              const datum = data.find((d) => d.month === monthKey);
              if (!datum) return null;
              const eventColor = colors.event[event.category];
              return (
                <ReferenceDot
                  key={event.id}
                  x={monthKey}
                  y={datum.consumption}
                  r={5}
                  fill={eventColor}
                  stroke="var(--card)"
                  strokeWidth={1.5}
                  isFront
                  ifOverflow="extendDomain"
                  label={renderEventLabel(
                    event.title,
                    eventColor,
                    compact,
                    eventLabelOffset.get(event.id) ?? 0,
                  )}
                />
              );
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <ChartLegend
        events={forecast.events}
        colors={colors}
        scenarioLabel={scenario?.label ?? null}
      />
    </Card>
  );
}

// Recharts types its LabelList `content` callback with the same broad shape
// as its own ImplicitLabelType, so we accept any and validate the fields we
// actually use at runtime.
function renderEndLabel(lastIndex: number, text: string, fill: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (props: any): React.JSX.Element | null => {
    if (props?.index !== lastIndex) return null;
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

// Renders an event's title as a boxed vertical text label sitting below its
// dot, with a leader line pointing back up to the datapoint. The box border and
// text are coloured to match the category. `offsetX` shifts labels of same-month
// events into adjacent columns so they don't stack. Recharts invokes this as a
// Label `content` component and passes the dot's `viewBox`
// ({ x: cx - r, y: cy - r, width: 2r, height: 2r }).
function renderEventLabel(title: string, color: string, compact: boolean, offsetX: number) {
  // Recharts' `label` prop (ImplicitLabelType) types this render callback as
  // returning a non-null SVG element, so guard branches return an empty <g/>
  // (renders nothing) rather than null.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (props: any): React.JSX.Element => {
    const viewBox = props?.viewBox;
    if (!viewBox) return <g />;
    const vbX = Number(viewBox.x);
    const vbY = Number(viewBox.y);
    const vbW = Number(viewBox.width);
    const vbH = Number(viewBox.height);
    if (![vbX, vbY, vbW, vbH].every(Number.isFinite)) return <g />;

    const dotCx = vbX + vbW / 2;
    const dotCy = vbY + vbH / 2;
    const dotTop = vbY;
    const dotBottom = vbY + vbH;
    const centerX = dotCx + offsetX;

    const fontSize = compact ? 9 : 10;
    const text = truncateLabel(title, compact ? 12 : 18);
    // Box wraps the rotated text: its height follows the text length, its width
    // follows the glyph height. Estimates from the font size keep it snug
    // without measuring the DOM.
    const padX = 4;
    const padY = 5;
    const boxWidth = Math.round(fontSize * 1.2) + padX * 2;
    const boxHeight = Math.round(text.length * fontSize * 0.6) + padY * 2;

    const leaderGap = 8;
    const needed = boxHeight + leaderGap;
    // Default below the dot; flip above only when there isn't room below but
    // there is above, so low datapoints near the x-axis don't clip.
    const roomBelow = CHART_PLOT_BOTTOM - dotBottom;
    const roomAbove = dotTop - CHART_PLOT_TOP;
    const below = needed <= roomBelow || roomBelow >= roomAbove;

    // Anchor the leader/box on the chosen side. `boxTop` is the box's upper
    // edge; the leader runs from the dot to whichever box edge faces it.
    const boxTop = below ? dotBottom + leaderGap : dotTop - leaderGap - boxHeight;
    const leaderY = below ? boxTop : boxTop + boxHeight;
    const boxLeft = centerX - boxWidth / 2;
    const textY = boxTop + boxHeight / 2;

    return (
      <g style={{ pointerEvents: 'none' }}>
        {/* Leader line from the datapoint to the box (its dot-side end is hidden
            under the dot marker, so it reads as coming out of the dot). */}
        <line
          x1={dotCx}
          y1={dotCy}
          x2={centerX}
          y2={leaderY}
          stroke={color}
          strokeWidth={1}
          strokeOpacity={0.75}
        />
        <rect
          x={boxLeft}
          y={boxTop}
          width={boxWidth}
          height={boxHeight}
          rx={3}
          fill="var(--card)"
          stroke={color}
          strokeWidth={1.25}
        />
        <text
          x={centerX}
          y={textY}
          transform={`rotate(-90, ${centerX}, ${textY})`}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={fontSize}
          fontWeight={600}
          fill={color}
        >
          {text}
        </text>
      </g>
    );
  };
}

function truncateLabel(title: string, max: number): string {
  const trimmed = title.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
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
  scenarioLabel: string | null;
}

function ChartLegend({ events, colors, scenarioLabel }: ChartLegendProps): React.JSX.Element {
  const categories = Array.from(new Set(events.map((e) => e.category)));
  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-fg-muted">
      <LegendItem swatch={colors.consumption} label="Consumption" />
      <LegendItem swatch={colors.capacity} label="Capacity ceiling" dashed />
      <LegendItem swatch={colors.capacity} label="Headroom" dashed faint />
      {scenarioLabel ? (
        <LegendItem swatch={colors.consumption} label={`Scenario: ${scenarioLabel}`} dashed />
      ) : null}
      {categories.length > 0 ? (
        <span aria-hidden className="mx-1">
          ·
        </span>
      ) : null}
      {categories.map((category) => (
        <LegendItem
          key={category}
          swatch={colors.event[category]}
          label={categoryLabel(category)}
          dot
        />
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

function categoryLabel(category: EventCategory): string {
  switch (category) {
    case 'growth':
      return 'Growth';
    case 'hardware_change':
      return 'Hardware';
    case 'openshift':
      return 'OpenShift';
    case 'note':
      return 'Note';
  }
}
