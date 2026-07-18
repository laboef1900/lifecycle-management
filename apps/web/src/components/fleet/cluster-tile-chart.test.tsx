import type { ForecastMonthPoint } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ClusterTileChart } from './cluster-tile-chart';

vi.mock('@/lib/use-chart-colors', () => ({
  useChartColors: () => ({
    consumption: '#8a6016',
    consumptionFill: 'rgba(138, 96, 22, 0.10)',
    capacity: '#b91c1c',
    grid: '#e5e5e5',
    axis: '#737373',
    utilizationOk: '#525252',
    utilizationWarn: '#b45309',
    utilizationCrit: '#b91c1c',
    eventNamed: {},
    eventPalette: [],
  }),
}));

// A minimal stand-in for the Recharts tooltip content render props — just the
// fields the tile chart's content function reads.
interface TooltipRenderProps {
  active?: boolean;
  label?: string;
  payload?: Array<{ payload?: unknown; value?: unknown }>;
}

vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }): React.JSX.Element => <>{children}</>;
  return {
    ResponsiveContainer: Pass,
    ComposedChart: ({ data, children }: { data: unknown; children?: React.ReactNode }) => (
      <div data-testid="chart" data-rows={JSON.stringify(data)}>
        {children}
      </div>
    ),
    CartesianGrid: () => <div data-testid="grid" />,
    XAxis: ({
      dataKey,
      tickFormatter,
      interval,
      minTickGap,
    }: {
      dataKey?: string;
      tickFormatter?: (value: string) => string;
      interval?: number | string;
      minTickGap?: number;
    }) => (
      <div
        data-testid="x-axis"
        data-key={dataKey}
        data-sample={tickFormatter ? tickFormatter('2026-07-01') : ''}
        data-interval={String(interval)}
        data-min-tick-gap={String(minTickGap)}
      />
    ),
    YAxis: ({
      domain,
      ticks,
      allowDataOverflow,
      tickFormatter,
    }: {
      domain: [number, number];
      ticks?: number[];
      allowDataOverflow?: boolean;
      tickFormatter?: (value: number) => string;
    }) => (
      <div
        data-testid="y-axis"
        data-domain={JSON.stringify(domain)}
        data-ticks={JSON.stringify(ticks)}
        data-allow-overflow={String(Boolean(allowDataOverflow))}
        data-sample={tickFormatter ? tickFormatter(100) : ''}
      />
    ),
    // Invoke the content render fn with a synthetic active payload so the tile's
    // tooltip logic (which must report the TRUE utilization) is exercised.
    Tooltip: ({ content }: { content: (props: TooltipRenderProps) => React.ReactNode }) => (
      <div data-testid="tooltip">
        {content({
          active: true,
          label: '2026-07-01',
          payload: [
            { payload: { month: '2026-07-01', util: 12.5, actual: 40, forecast: 40 }, value: 40 },
          ],
        })}
      </div>
    ),
    Line: ({ dataKey }: { dataKey: string }) => <div data-testid={`line-${dataKey}`} />,
    // `data-y` is surfaced separately from the testid so tests can assert the
    // clamped y of every hairline in render order (warn, crit, capacity) even
    // when two of them collapse onto the same clamped value.
    ReferenceLine: ({ x, y }: { x?: string; y?: number }) => (
      <div data-testid={x !== undefined ? `refline-x-${x}` : `refline-y-${y}`} data-y={y} />
    ),
    ReferenceDot: ({ x, y, fill }: { x: string; y: number; fill?: string }) => (
      <div data-testid="breach-dot" data-x={x} data-y={y} data-fill={fill} />
    ),
  };
});

const months: ForecastMonthPoint[] = [
  { month: '2026-07-01', consumption: 700, capacity: 1000, utilization: 0.7 },
  { month: '2026-08-01', consumption: 800, capacity: 1000, utilization: 0.8 },
  { month: '2026-09-01', consumption: 920, capacity: 1000, utilization: 0.92 },
  { month: '2026-10-01', consumption: 1000, capacity: 1000, utilization: 1.0 },
];

describe('<ClusterTileChart>', () => {
  it('renders nothing when there are no months', () => {
    const { container } = render(
      <ClusterTileChart months={[]} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('uses a fixed, tightened 40-125 y-domain shared across tiles (spec §4.4, amended)', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    const yAxis = screen.getByTestId('y-axis');
    expect(yAxis.dataset.domain).toBe('[40,125]');
    // allowDataOverflow keeps the shared window fixed against out-of-range data.
    expect(yAxis.dataset.allowOverflow).toBe('true');
    // Y ticks are labeled as percentages.
    expect(yAxis.dataset.ticks).toBe('[50,75,100]');
    expect(yAxis.dataset.sample).toBe('100%');
  });

  it('describes the shared 40-125 scale in the chart aria-label', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('shared 40 to 125 percent scale across tiles');
    expect(label).toContain('Warn threshold 70 percent');
  });

  it('labels the x-axis with short month names (no longer hidden)', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    const xAxis = screen.getByTestId('x-axis');
    expect(xAxis.dataset.key).toBe('month');
    expect(xAxis.dataset.sample).toBe('Jul 26'); // formatMonthShort('2026-07-01')
  });

  it('thins x-axis labels so 12 months cannot collide at tile width (#224 point 1)', () => {
    // These two props are the entire anti-overlap mechanism: at ~1/3-tile width
    // a 12-month window would otherwise stack month labels on top of each other.
    // Recharts' defaults (interval="preserveEnd", minTickGap=5) are NOT enough,
    // so a silent revert to them must fail here.
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    const xAxis = screen.getByTestId('x-axis');
    expect(xAxis.dataset.interval).toBe('preserveStartEnd');
    expect(xAxis.dataset.minTickGap).toBe('28');
  });

  it('splits consumption into an actual line up to the current month and a forecast line after', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    expect(screen.getByTestId('line-actual')).toBeInTheDocument();
    expect(screen.getByTestId('line-forecast')).toBeInTheDocument();
    const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
      month: string;
      util: number;
      actual: number | null;
      forecast: number | null;
    }>;
    // The fetched window always starts at the current month (index 0), so the
    // "actual" series is the single anchor point and everything (including
    // that same anchor) is also part of the dashed "forecast" series. All these
    // values are within [40,125] so the plotted line equals the true util.
    expect(rows[0]).toEqual({ month: '2026-07-01', util: 70, actual: 70, forecast: 70 });
    expect(rows[1]).toEqual({ month: '2026-08-01', util: 80, actual: null, forecast: 80 });
  });

  it('clamps below-floor utilization to the window edge while keeping the true value for the tooltip', () => {
    // Zero/unknown-capacity clusters (#198) report 0% and would sit entirely
    // below the 40% floor. The plotted line pins to the floor so it stays
    // visible; the true util is preserved on the row for the tooltip.
    const lowMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 100, capacity: 1000, utilization: 0.1 },
      { month: '2026-08-01', consumption: 0, capacity: 0, utilization: 0 },
    ];
    render(
      <ClusterTileChart
        months={lowMonths}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
      month: string;
      util: number;
      actual: number | null;
      forecast: number | null;
    }>;
    expect(rows[0]).toEqual({ month: '2026-07-01', util: 10, actual: 40, forecast: 40 });
    expect(rows[1]).toEqual({ month: '2026-08-01', util: 0, actual: null, forecast: 40 });
  });

  it('clamps above-ceiling utilization to the window top so it cannot stretch the shared scale', () => {
    // A cluster already past capacity (>125 %) must pin to the ceiling: letting
    // it through would either expand the axis (breaking cross-tile
    // comparability) or, with allowDataOverflow, draw off-window.
    const overMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 1400, capacity: 1000, utilization: 1.4 },
      { month: '2026-08-01', consumption: 1600, capacity: 1000, utilization: 1.6 },
    ];
    render(
      <ClusterTileChart
        months={overMonths}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
      month: string;
      util: number;
      actual: number | null;
      forecast: number | null;
    }>;
    // True util is preserved for the tooltip; only the plotted values clamp.
    expect(rows[0]).toEqual({ month: '2026-07-01', util: 140, actual: 125, forecast: 125 });
    expect(rows[1]).toEqual({ month: '2026-08-01', util: 160, actual: null, forecast: 125 });
    // The breach dot rides the same clamp — at util 140 it must sit at 125.
    expect(screen.getByTestId('breach-dot').dataset.y).toBe('125');
  });

  it('pins the breach dot to the floor when the warn threshold is below the window', () => {
    // Mirror of the above: warn=0.35 makes month 0 (10 % util) a breach, and the
    // dot must clamp UP to the 40 % floor rather than render off-window.
    const lowMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 100, capacity: 1000, utilization: 0.1 },
    ];
    render(
      <ClusterTileChart
        months={lowMonths}
        thresholds={{ warn: 0.05, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    expect(screen.getByTestId('breach-dot').dataset.y).toBe('40');
  });

  it('tooltip reports the true utilization, not the clamped plotted value', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    // The mock feeds the content fn a payload whose true util is 12.5 while the
    // plotted (clamped) value is 40 — the tooltip must show 12.5%.
    const tooltip = screen.getByTestId('tooltip');
    expect(tooltip).toHaveTextContent('12.5%');
    expect(tooltip).not.toHaveTextContent('40.0%');
  });

  it('draws warn, crit, and 100% capacity reference lines', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    expect(screen.getByTestId('refline-y-70')).toBeInTheDocument();
    expect(screen.getByTestId('refline-y-90')).toBeInTheDocument();
    expect(screen.getByTestId('refline-y-100')).toBeInTheDocument();
  });

  it('clamps a sub-40% warn threshold up to the floor so its hairline stays visible', () => {
    // percentSchema allows thresholds down to 0.01, so warn=0.35 is a legal,
    // saveable config. Recharts' ReferenceLine defaults to ifOverflow="discard"
    // and would render NOTHING below the 40% floor — while the breach dot still
    // pins to the floor and the aria-label still names the threshold. Clamping
    // keeps the tile self-consistent.
    render(
      <ClusterTileChart
        months={months}
        thresholds={{ warn: 0.35, crit: 0.5 }}
        orderByDate={null}
      />,
    );
    // Render order: warn, crit, then the fixed 100% capacity line.
    const ys = screen.getAllByTestId(/^refline-y-/).map((el) => el.dataset.y);
    expect(ys).toEqual(['40', '50', '100']);
  });

  it('clamps a sub-40% CRIT threshold to the floor too, and keeps the aria-label truthful', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.2, crit: 0.3 }} orderByDate={null} />,
    );
    // Both hairlines collapse onto the floor: the whole visible window is then
    // genuinely at or above crit, which is what the tile shows.
    const ys = screen.getAllByTestId(/^refline-y-/).map((el) => el.dataset.y);
    expect(ys).toEqual(['40', '40', '100']);
    // The clamp is presentational only — the accessible description must still
    // report the REAL configured percentages, not the clamped floor.
    const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('Warn threshold 20 percent');
    expect(label).toContain('Critical threshold 30 percent');
  });

  it('marks the first month at or above warn with a breach dot filled in the warn color, not crit (PR review fix 4a)', () => {
    // The dot is positioned at the warn-threshold crossing (`thresholds.warn`
    // in `breachIndex`), so its fill must be `utilizationWarn` — filling it
    // with `utilizationCrit` visually mislabels a warn breach as a crit one.
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    const dot = screen.getByTestId('breach-dot');
    expect(dot.dataset.x).toBe('2026-07-01');
    expect(dot.dataset.fill).toBe('#b45309'); // utilizationWarn — not utilizationCrit (#b91c1c)
  });

  it('omits the breach dot when no month reaches warn', () => {
    const lowMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 100, capacity: 1000, utilization: 0.1 },
    ];
    render(
      <ClusterTileChart
        months={lowMonths}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    expect(screen.queryByTestId('breach-dot')).toBeNull();
  });

  it('draws an order-by marker when the order-by month falls in range', () => {
    render(
      <ClusterTileChart
        months={months}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate="2026-09-14"
      />,
    );
    expect(screen.getByTestId('refline-x-2026-09-01')).toBeInTheDocument();
  });

  it('omits the order-by marker when there is no order-by date', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    expect(screen.queryByTestId(/refline-x-/)).toBeNull();
  });
});
