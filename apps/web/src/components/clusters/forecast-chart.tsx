import type { EventCategory, ForecastResponse } from '@lcm/shared';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface ForecastChartProps {
  forecast: ForecastResponse;
}

const eventCategoryColor: Record<EventCategory, string> = {
  growth: 'oklch(60% 0.15 50)',
  hardware_change: 'oklch(55% 0.18 145)',
  openshift: 'oklch(55% 0.20 290)',
  note: 'oklch(55% 0.02 260)',
};

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
  const data = forecast.months.map((point) => ({
    month: point.month,
    consumption: Math.round(point.consumption),
    capacity: Math.round(point.capacity),
  }));

  const eventsByMonth = new Map<string, ForecastResponse['events']>();
  for (const event of forecast.events) {
    const monthKey = `${event.effectiveDate.slice(0, 7)}-01`;
    const bucket = eventsByMonth.get(monthKey) ?? [];
    bucket.push(event);
    eventsByMonth.set(monthKey, bucket);
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 12, right: 16, bottom: 0, left: 8 }}>
            <defs>
              <linearGradient id="forecast-consumption" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="oklch(45% 0.15 250)" stopOpacity={0.45} />
                <stop offset="100%" stopColor="oklch(45% 0.15 250)" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(92% 0.005 260)" />
            <XAxis
              dataKey="month"
              tickFormatter={formatMonth}
              tick={{ fontSize: 11 }}
              stroke="oklch(45% 0.02 260)"
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis
              tick={{ fontSize: 11 }}
              stroke="oklch(45% 0.02 260)"
              tickFormatter={(v: number) => numberFormat.format(v)}
              label={{
                value: 'GB',
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: 11, fill: 'oklch(45% 0.02 260)' },
              }}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0 || typeof label !== 'string') {
                  return null;
                }
                const consumption = (payload[0]?.value as number) ?? 0;
                const capacity = (payload[1]?.value as number) ?? 0;
                const utilization = capacity > 0 ? (consumption / capacity) * 100 : 0;
                const monthEvents = eventsByMonth.get(label) ?? [];
                return (
                  <div className="rounded-md border bg-card p-3 text-xs shadow">
                    <div className="font-medium">{formatMonth(label)}</div>
                    <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                      <dt className="text-muted-foreground">Consumption</dt>
                      <dd className="text-right tabular-nums">
                        {numberFormat.format(consumption)} GB
                      </dd>
                      <dt className="text-muted-foreground">Capacity</dt>
                      <dd className="text-right tabular-nums">
                        {numberFormat.format(capacity)} GB
                      </dd>
                      <dt className="text-muted-foreground">Utilization</dt>
                      <dd className="text-right tabular-nums">{utilization.toFixed(1)}%</dd>
                    </dl>
                    {monthEvents.length > 0 ? (
                      <ul className="mt-2 space-y-1 border-t pt-2">
                        {monthEvents.map((event) => (
                          <li key={event.id} className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className="h-2 w-2 rounded-full"
                              style={{ background: eventCategoryColor[event.category] }}
                            />
                            <span className="flex-1 truncate">{event.title}</span>
                            <span className="tabular-nums text-muted-foreground">
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
              stroke="oklch(45% 0.15 250)"
              strokeWidth={2}
              fill="url(#forecast-consumption)"
              isAnimationActive={false}
            />
            <Line
              type="stepAfter"
              dataKey="capacity"
              name="Capacity"
              stroke="oklch(55% 0.20 25)"
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
                  fill={eventCategoryColor[event.category]}
                  stroke="white"
                  strokeWidth={1.5}
                  isFront
                  ifOverflow="extendDomain"
                />
              );
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <ChartLegend events={forecast.events} />
    </div>
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

function ChartLegend({ events }: { events: ForecastResponse['events'] }): React.JSX.Element {
  const categories = Array.from(new Set(events.map((e) => e.category)));
  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
      <LegendItem swatch="oklch(45% 0.15 250)" label="Consumption" />
      <LegendItem swatch="oklch(55% 0.20 25)" label="Capacity ceiling" dashed />
      {categories.length > 0 ? (
        <span aria-hidden className="mx-1">
          ·
        </span>
      ) : null}
      {categories.map((category) => (
        <LegendItem
          key={category}
          swatch={eventCategoryColor[category]}
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
}: {
  swatch: string;
  label: string;
  dot?: boolean;
  dashed?: boolean;
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className={dot ? 'h-2 w-2 rounded-full' : 'h-0 w-4 border-t-2'}
        style={
          dot
            ? { background: swatch }
            : { borderColor: swatch, borderStyle: dashed ? 'dashed' : 'solid' }
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
