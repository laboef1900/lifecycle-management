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

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useChartColors, type ChartColors } from '@/lib/use-chart-colors';

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

function utilizationColor(value: number, colors: ChartColors): string {
  if (value >= 0.9) return colors.utilizationCrit;
  if (value >= 0.7) return colors.utilizationWarn;
  return colors.utilizationOk;
}

export function UtilizationPanel({ forecast }: UtilizationPanelProps): React.JSX.Element {
  const colors = useChartColors();
  const data = forecast.months.map((point) => ({
    month: point.month,
    pct: Number((point.utilization * 100).toFixed(1)),
  }));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
        <CardTitle>Monthly utilization</CardTitle>
        <span className="text-xs text-fg-muted">% capacity used</span>
      </CardHeader>
      <CardContent className="pt-2">
        <div className="h-[140px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 56, bottom: 0, left: 8 }}>
              <XAxis
                dataKey="month"
                tickFormatter={formatMonth}
                tick={{ fontSize: 10 }}
                stroke={colors.axis}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                domain={[0, (max: number) => Math.max(100, Math.ceil(max / 10) * 10)]}
                tick={{ fontSize: 10 }}
                stroke={colors.axis}
                tickFormatter={(v: number) => `${v}%`}
                width={36}
              />
              <ReferenceLine
                y={70}
                stroke={colors.utilizationWarn}
                strokeDasharray="2 2"
                label={{
                  value: 'Warn 70%',
                  position: 'right',
                  fontSize: 10,
                  fill: colors.utilizationWarn,
                }}
              />
              <ReferenceLine
                y={90}
                stroke={colors.utilizationCrit}
                strokeDasharray="2 2"
                label={{
                  value: 'Crit 90%',
                  position: 'right',
                  fontSize: 10,
                  fill: colors.utilizationCrit,
                }}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload || payload.length === 0 || typeof label !== 'string') {
                    return null;
                  }
                  const pct = payload[0]?.value as number;
                  return (
                    <div className="rounded-md border border-border bg-popover p-2 text-xs text-popover-foreground shadow-md">
                      <div className="font-medium">{formatMonth(label)}</div>
                      <div className="font-mono tabular-nums text-fg-muted">{pct.toFixed(1)}%</div>
                    </div>
                  );
                }}
              />
              <Bar dataKey="pct" isAnimationActive={false} radius={[2, 2, 0, 0]}>
                {data.map((entry) => (
                  <Cell key={entry.month} fill={utilizationColor(entry.pct / 100, colors)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
