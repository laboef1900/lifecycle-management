import type { EventCategory, ForecastResponse } from '@lcm/shared';
import {
  Area,
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

import { Card } from '@/components/ui/card';
import { useChartColors } from '@/lib/use-chart-colors';

interface ForecastChartProps {
  forecast: ForecastResponse;
}

const numberFormat = new Intl.NumberFormat('en-US');

function formatMonth(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
}

export function ForecastChart({ forecast }: ForecastChartProps): React.JSX.Element {
  const colors = useChartColors();
  const data = forecast.months.map((point) => ({
    month: point.month,
    consumption: Math.round(point.consumption),
    headroom: Math.max(0, Math.round(point.capacity - point.consumption)),
    capacity: Math.round(point.capacity),
  }));
  const maxCeiling = data.reduce((max, d) => Math.max(max, d.capacity), 0);
  const ceilingForDomain = maxCeiling > 0 ? maxCeiling * 1.05 : undefined;

  const eventsByMonth = new Map<string, ForecastResponse['events']>();
  for (const event of forecast.events) {
    const monthKey = `${event.effectiveDate.slice(0, 7)}-01`;
    const bucket = eventsByMonth.get(monthKey) ?? [];
    bucket.push(event);
    eventsByMonth.set(monthKey, bucket);
  }

  return (
    <Card className="p-4">
      <div className="h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 12, right: 16, bottom: 0, left: 8 }}>
            <defs>
              <linearGradient id="forecast-consumption" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.consumption} stopOpacity={0.45} />
                <stop offset="100%" stopColor={colors.consumption} stopOpacity={0.05} />
              </linearGradient>
            </defs>
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
              domain={ceilingForDomain ? [0, ceilingForDomain] : ['auto', 'auto']}
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
                const consumption =
                  (payload.find((p) => p.dataKey === 'consumption')?.value as number) ?? 0;
                const headroom =
                  (payload.find((p) => p.dataKey === 'headroom')?.value as number) ?? 0;
                const capacity = consumption + headroom;
                const utilization = capacity > 0 ? (consumption / capacity) * 100 : 0;
                const monthEvents = eventsByMonth.get(label) ?? [];
                return (
                  <div className="rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md">
                    <div className="font-medium">{formatMonth(label)}</div>
                    <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                      <dt className="text-muted-foreground">Consumption</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {numberFormat.format(consumption)} GB
                      </dd>
                      <dt className="text-muted-foreground">Capacity</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {numberFormat.format(capacity)} GB
                      </dd>
                      <dt className="text-muted-foreground">Headroom</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {numberFormat.format(headroom)} GB
                      </dd>
                      <dt className="text-muted-foreground">Utilization</dt>
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
                            <span className="font-mono tabular-nums text-muted-foreground">
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
              <>
                <ReferenceLine
                  y={maxCeiling * 0.7}
                  stroke={colors.utilizationWarn}
                  strokeDasharray="2 2"
                  label={{
                    value: `Warn ${numberFormat.format(Math.round(maxCeiling * 0.7))}`,
                    position: 'right',
                    fontSize: 10,
                    fill: colors.utilizationWarn,
                  }}
                />
                <ReferenceLine
                  y={maxCeiling * 0.9}
                  stroke={colors.utilizationCrit}
                  strokeDasharray="2 2"
                  label={{
                    value: `Crit ${numberFormat.format(Math.round(maxCeiling * 0.9))}`,
                    position: 'right',
                    fontSize: 10,
                    fill: colors.utilizationCrit,
                  }}
                />
              </>
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
                  fill={colors.event[event.category]}
                  stroke="var(--card)"
                  strokeWidth={1.5}
                  isFront
                  ifOverflow="extendDomain"
                />
              );
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <ChartLegend events={forecast.events} colors={colors} />
    </Card>
  );
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
}

function ChartLegend({ events, colors }: ChartLegendProps): React.JSX.Element {
  const categories = Array.from(new Set(events.map((e) => e.category)));
  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
      <LegendItem swatch={colors.consumption} label="Consumption" />
      <LegendItem swatch={colors.capacity} label="Capacity ceiling" dashed />
      <LegendItem swatch={colors.capacity} label="Headroom" dashed faint />
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
