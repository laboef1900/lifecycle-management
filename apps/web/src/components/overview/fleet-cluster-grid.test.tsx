import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ClusterForecastEntry } from '@/lib/forecast-summary';

import { FleetClusterGrid } from './fleet-cluster-grid';

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
    clusterPalette: ['#171717', '#404040', '#525252', '#737373', '#a3a3a3'],
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
    return (
      <a href={href} data-testid="tile-link">
        {children}
      </a>
    );
  },
}));

// Stub recharts the same way the tile-chart test does — we only need to
// assert on which tiles render, not on chart internals.
vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }): React.JSX.Element => <>{children}</>;
  return {
    ResponsiveContainer: Pass,
    LineChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Line: () => null,
    ReferenceArea: () => null,
  };
});

function makeCluster(name: string): ClusterResponse {
  return {
    id: `c-${name}`,
    name,
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
}

const months: ForecastMonthPoint[] = [
  { month: '2026-05-01', consumption: 400, capacity: 1000, utilization: 0.4 },
];

function entry(name: string, summary: ClusterForecastEntry['summary']): ClusterForecastEntry {
  return {
    cluster: makeCluster(name),
    months,
    thresholds: { warn: 0.7, crit: 0.9 },
    summary,
  };
}

function visibleNamesInOrder(): string[] {
  return screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent ?? '');
}

describe('<FleetClusterGrid>', () => {
  it('sorts: already-crit, then already-warn, then ascending months-to-breach, then no-breach', () => {
    const entries: ClusterForecastEntry[] = [
      entry('no-breach', { months: null, alreadyBreached: false }),
      entry('crit-now', { months: 0, alreadyBreached: 'crit' }),
      entry('warn-in-3', { months: 3, alreadyBreached: false }),
      entry('warn-now', { months: 0, alreadyBreached: 'warn' }),
      entry('warn-in-1', { months: 1, alreadyBreached: false }),
    ];
    render(<FleetClusterGrid entries={entries} />);
    expect(visibleNamesInOrder()).toEqual([
      'crit-now',
      'warn-now',
      'warn-in-1',
      'warn-in-3',
      'no-breach',
    ]);
  });

  it('breaks ties on the sort key alphabetically by cluster name', () => {
    const entries: ClusterForecastEntry[] = [
      entry('Beta', { months: 2, alreadyBreached: false }),
      entry('Alpha', { months: 2, alreadyBreached: false }),
    ];
    render(<FleetClusterGrid entries={entries} />);
    expect(visibleNamesInOrder()).toEqual(['Alpha', 'Beta']);
  });

  it('renders a skeleton grid when isLoading and no entries are given', () => {
    render(<FleetClusterGrid entries={[]} isLoading />);
    expect(screen.getByTestId('grid-skeleton')).toBeInTheDocument();
  });

  it('renders nothing for an empty non-loading entries list', () => {
    const { container } = render(<FleetClusterGrid entries={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
