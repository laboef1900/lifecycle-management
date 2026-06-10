import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ClusterForecastEntry } from '@/lib/forecast-summary';

import { FleetClusterTileChart } from './fleet-cluster-tile-chart';

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
    event: { growth: '#171717', hardware_change: '#525252', openshift: '#737373', note: '#a3a3a3' },
  }),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => {
    let href = to;
    for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, v);
    return <a href={href}>{children}</a>;
  },
}));

vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }): React.JSX.Element => <>{children}</>;
  return {
    ResponsiveContainer: Pass,
    LineChart: ({ data, children }: { data: unknown; children?: React.ReactNode }) => (
      <div data-testid="chart" data-rows={JSON.stringify(data)}>
        {children}
      </div>
    ),
    CartesianGrid: () => <div data-testid="grid" />,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Line: ({ dataKey }: { dataKey: string }) => <div data-testid={`line-${dataKey}`} />,
    ReferenceArea: ({ y1, y2 }: { y1: number; y2: number }) => (
      <div data-testid="reference-area" data-y1={y1} data-y2={y2} />
    ),
  };
});

const cluster: ClusterResponse = {
  id: 'c1',
  name: 'CL-Test',
  description: null,
  baselineDate: '2026-05-01',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  archivedAt: null,
  metrics: [
    {
      metricTypeKey: 'memory_gb',
      metricTypeDisplayName: 'Memory',
      unit: 'GB',
      baselineConsumption: 400,
      baselineCapacity: 1000,
      currentConsumption: 400,
      currentCapacity: 1000,
      utilization: 0.4,
    },
  ],
};

const months: ForecastMonthPoint[] = [
  { month: '2026-05-01', consumption: 400, capacity: 1000, utilization: 0.4 },
  { month: '2026-06-01', consumption: 800, capacity: 1000, utilization: 0.8 },
];

function entry(overrides: Partial<ClusterForecastEntry> = {}): ClusterForecastEntry {
  return {
    cluster,
    months,
    thresholds: { warn: 0.7, crit: 0.9 },
    summary: { months: 1, alreadyBreached: false },
    ...overrides,
  };
}

describe('<FleetClusterTileChart>', () => {
  it('renders the cluster name, a runway pill using cluster thresholds, and a utilization line', () => {
    render(<FleetClusterTileChart entry={entry()} />);
    expect(screen.getByText('CL-Test')).toBeInTheDocument();
    expect(screen.getByText(/1 mo to 70%/i)).toBeInTheDocument();
    expect(screen.getByTestId('line-util')).toBeInTheDocument();
  });

  it('labels the Y axis as Utilization (%)', () => {
    render(<FleetClusterTileChart entry={entry()} />);
    expect(screen.getByTestId('tile-y-axis-label')).toHaveTextContent('Utilization (%)');
  });

  it('omits the Y axis label when there is no chart to label', () => {
    render(<FleetClusterTileChart entry={entry({ months: [] })} />);
    expect(screen.queryByTestId('tile-y-axis-label')).toBeNull();
  });

  it('omits the Y axis label when the entry failed to load', () => {
    render(<FleetClusterTileChart entry={entry({ months: [], error: 'timeout' })} />);
    expect(screen.queryByTestId('tile-y-axis-label')).toBeNull();
  });

  it('uses the cluster-specific thresholds for the runway pill label', () => {
    render(
      <FleetClusterTileChart
        entry={entry({
          thresholds: { warn: 0.45, crit: 0.48 },
          summary: { months: 0, alreadyBreached: 'warn' },
        })}
      />,
    );
    expect(screen.getByText(/Over 45%/i)).toBeInTheDocument();
  });

  it('feeds the chart utilization values per month (consumption / capacity)', () => {
    render(<FleetClusterTileChart entry={entry()} />);
    const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
      month: string;
      util: number;
    }>;
    expect(rows).toEqual([
      { month: '2026-05-01', util: 0.4 },
      { month: '2026-06-01', util: 0.8 },
    ]);
  });

  it('renders two threshold bands at warn..crit and crit..1', () => {
    render(<FleetClusterTileChart entry={entry()} />);
    const bands = screen.getAllByTestId('reference-area');
    expect(bands).toHaveLength(2);
    expect(bands[0]?.dataset.y1).toBe('0.7');
    expect(bands[0]?.dataset.y2).toBe('0.9');
    expect(bands[1]?.dataset.y1).toBe('0.9');
    expect(bands[1]?.dataset.y2).toBe('1');
  });

  it('wraps the tile in a link to the cluster detail page', () => {
    render(<FleetClusterTileChart entry={entry()} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/clusters/c1');
  });

  it('renders "No forecast" body when the cluster has no months', () => {
    render(<FleetClusterTileChart entry={entry({ months: [] })} />);
    expect(screen.getByText('CL-Test')).toBeInTheDocument();
    expect(screen.getByText(/No forecast/i)).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).toBeNull();
  });

  it('renders the actual error message when the entry has a load failure', () => {
    render(
      <FleetClusterTileChart entry={entry({ months: [], error: 'Failed to load forecast' })} />,
    );
    expect(screen.getByText('CL-Test')).toBeInTheDocument();
    expect(screen.getByText('Failed to load forecast')).toBeInTheDocument();
    expect(screen.queryByText(/No forecast/i)).toBeNull();
  });

  it('renders "No metric configured" for metric-less clusters instead of a load failure', () => {
    render(<FleetClusterTileChart entry={entry({ months: [], error: 'No metric configured' })} />);
    expect(screen.getByText('No metric configured')).toBeInTheDocument();
    expect(screen.queryByText(/Failed to load/i)).toBeNull();
    expect(screen.queryByText(/No forecast/i)).toBeNull();
  });

  it('exposes the tile chart as a labelled image', () => {
    render(<FleetClusterTileChart entry={entry()} />);

    expect(screen.getByRole('img', { name: /utilization forecast/i })).toBeInTheDocument();
  });
});
