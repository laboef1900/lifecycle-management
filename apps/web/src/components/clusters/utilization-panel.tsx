import type { ForecastResponse } from '@lcm/shared';
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface UtilizationPanelProps {
  forecast: ForecastResponse;
}

function formatMonth(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
}

function utilizationColor(value: number): string {
  if (value >= 0.9) return 'oklch(55% 0.20 25)';
  if (value >= 0.7) return 'oklch(70% 0.16 75)';
  return 'oklch(55% 0.13 160)';
}

export function UtilizationPanel({ forecast }: UtilizationPanelProps): React.JSX.Element {
  const data = forecast.months.map((point) => ({
    month: point.month,
    pct: Number((point.utilization * 100).toFixed(1)),
  }));

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium">Monthly utilization</h3>
        <span className="text-xs text-muted-foreground">% capacity used</span>
      </div>
      <div className="h-[140px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
            <XAxis
              dataKey="month"
              tickFormatter={formatMonth}
              tick={{ fontSize: 10 }}
              stroke="oklch(45% 0.02 260)"
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis
              domain={[0, (max: number) => Math.max(100, Math.ceil(max / 10) * 10)]}
              tick={{ fontSize: 10 }}
              stroke="oklch(45% 0.02 260)"
              tickFormatter={(v: number) => `${v}%`}
              width={36}
            />
            <ReferenceLine y={70} stroke="oklch(70% 0.16 75)" strokeDasharray="2 2" />
            <ReferenceLine y={90} stroke="oklch(55% 0.20 25)" strokeDasharray="2 2" />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0 || typeof label !== 'string') {
                  return null;
                }
                const pct = payload[0]?.value as number;
                return (
                  <div className="rounded-md border bg-card p-2 text-xs shadow">
                    <div className="font-medium">{formatMonth(label)}</div>
                    <div className="text-muted-foreground">{pct.toFixed(1)}%</div>
                  </div>
                );
              }}
            />
            <Bar dataKey="pct" isAnimationActive={false} radius={[2, 2, 0, 0]}>
              {data.map((entry) => (
                <Cell key={entry.month} fill={utilizationColor(entry.pct / 100)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
