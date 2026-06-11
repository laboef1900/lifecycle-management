import type { ForecastResponse } from '@lcm/shared';
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
import { eventColor, useChartColors } from '@/lib/use-chart-colors';

interface ForecastChartProps {
  forecast: ForecastResponse;
  compact?: boolean;
  /** Optional scenario overlay — consumption line drawn dashed on top of baseline. */
  scenario?: { label: string; months: ForecastResponse['months'] } | null;
}

const numberFormat = new Intl.NumberFormat('en-US');

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
      {/* TODO(a11y): fold cluster/metric identity into this label before any multi-chart layout (PR 2 Radix rebuild). */}
      <div className="h-[320px] w-full" role="img" aria-label="Capacity forecast chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 12, right: compact ? 16 : 56, bottom: 0, left: 8 }}
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
              return (
                <ReferenceDot
                  key={event.id}
                  x={monthKey}
                  y={datum.consumption}
                  r={5}
                  fill={eventColor(colors, event.category)}
                  stroke="var(--card)"
                  strokeWidth={1.5}
                  ifOverflow="extendDomain"
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
