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
    XAxis: () => null,
    YAxis: ({ domain }: { domain: [number, number] }) => (
      <div data-testid="y-axis" data-domain={JSON.stringify(domain)} />
    ),
    Tooltip: () => null,
    Line: ({ dataKey }: { dataKey: string }) => <div data-testid={`line-${dataKey}`} />,
    ReferenceLine: ({ x, y }: { x?: string; y?: number }) => (
      <div data-testid={x !== undefined ? `refline-x-${x}` : `refline-y-${y}`} />
    ),
    ReferenceDot: ({ x, y }: { x: string; y: number }) => (
      <div data-testid="breach-dot" data-x={x} data-y={y} />
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

  it('uses a fixed 0-125 y-domain shared across tiles', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    expect(screen.getByTestId('y-axis').dataset.domain).toBe('[0,125]');
  });

  it('splits consumption into an actual line up to the current month and a forecast line after', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    expect(screen.getByTestId('line-actual')).toBeInTheDocument();
    expect(screen.getByTestId('line-forecast')).toBeInTheDocument();
    const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
      month: string;
      actual: number | null;
      forecast: number | null;
    }>;
    // The fetched window always starts at the current month (index 0), so the
    // "actual" series is the single anchor point and everything (including
    // that same anchor) is also part of the dashed "forecast" series.
    expect(rows[0]).toEqual({ month: '2026-07-01', actual: 70, forecast: 70 });
    expect(rows[1]).toEqual({ month: '2026-08-01', actual: null, forecast: 80 });
  });

  it('draws warn, crit, and 100% capacity reference lines', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    expect(screen.getByTestId('refline-y-70')).toBeInTheDocument();
    expect(screen.getByTestId('refline-y-90')).toBeInTheDocument();
    expect(screen.getByTestId('refline-y-100')).toBeInTheDocument();
  });

  it('marks the first month at or above warn with a breach dot', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    const dot = screen.getByTestId('breach-dot');
    expect(dot.dataset.x).toBe('2026-07-01');
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
