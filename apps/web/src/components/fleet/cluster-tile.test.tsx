import type { ClusterResponse, ForecastMonthPoint, ForecastResponse } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ClusterForecastEntry } from '@/lib/forecast-summary';

import { ClusterTile } from './cluster-tile';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => {
    let href = to;
    for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, v);
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

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
    ComposedChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Line: () => null,
    ReferenceLine: () => null,
    ReferenceDot: () => null,
  };
});

const invalidateQueries = vi.fn();
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

function cluster(overrides: Partial<ClusterResponse> = {}): ClusterResponse {
  return {
    id: 'c1',
    name: 'CL-Prod-P1',
    description: null,
    baselineDate: '2026-06-20',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archivedAt: null,
    metrics: [
      {
        metricTypeKey: 'memory_gb',
        metricTypeDisplayName: 'Memory',
        unit: 'GB',
        baselineConsumption: 19100,
        baselineCapacity: 24576,
        currentConsumption: 19100,
        currentCapacity: 24576,
        utilization: 0.777,
      },
    ],
    ...overrides,
  };
}

const months: ForecastMonthPoint[] = [
  { month: '2026-07-01', consumption: 19100, capacity: 24576, utilization: 0.777 },
  { month: '2026-08-01', consumption: 19400, capacity: 24576, utilization: 0.79 },
];

function entry(overrides: Partial<ClusterForecastEntry> = {}): ClusterForecastEntry {
  return {
    cluster: cluster(),
    months,
    thresholds: { warn: 0.7, crit: 0.9 },
    summary: { months: 0, alreadyBreached: 'warn' },
    ...overrides,
  };
}

function forecast(overrides: Partial<ForecastResponse> = {}): ForecastResponse {
  return {
    fromMonth: '2026-07-01',
    toMonth: '2028-06-01',
    months,
    events: [],
    hosts: [],
    applications: [],
    effectiveThresholds: { warn: 0.7, crit: 0.9, source: 'system' },
    procurement: { leadTimeWeeks: 13, orderByDate: '2026-12-28', breachMonth: '2027-04-01' },
    ...overrides,
  };
}

describe('<ClusterTile>', () => {
  it('links to the cluster detail page', () => {
    render(
      <ClusterTile entry={entry()} forecast={forecast()} thresholds={{ warn: 0.7, crit: 0.9 }} />,
    );
    expect(screen.getByRole('link')).toHaveAttribute('href', '/clusters/c1');
  });

  it('shows an "ORDER BY ... IN ..." chip when there is a projected order-by date', () => {
    render(
      <ClusterTile entry={entry()} forecast={forecast()} thresholds={{ warn: 0.7, crit: 0.9 }} />,
    );
    expect(screen.getByText(/ORDER BY 2026-12-28/)).toBeInTheDocument();
    expect(screen.getByText(/IN /)).toBeInTheDocument();
  });

  it('shows a "no order needed" chip when there is no projected order-by date', () => {
    render(
      <ClusterTile
        entry={entry()}
        forecast={forecast({
          procurement: { leadTimeWeeks: 13, orderByDate: null, breachMonth: null },
        })}
        thresholds={{ warn: 0.7, crit: 0.9 }}
      />,
    );
    expect(screen.getByText(/no order needed/i)).toBeInTheDocument();
  });

  it('shows a stale-baseline warning chip past 90 days', () => {
    render(
      <ClusterTile
        entry={entry({ cluster: cluster({ baselineDate: '2026-03-10' }) })}
        forecast={forecast()}
        thresholds={{ warn: 0.7, crit: 0.9 }}
      />,
    );
    expect(screen.getByText(/⚠ BASELINE \d+ D OLD/)).toBeInTheDocument();
  });

  it('shows a plain baseline chip for a fresh baseline', () => {
    render(
      <ClusterTile
        entry={entry({ cluster: cluster({ baselineDate: '2026-06-20' }) })}
        forecast={forecast()}
        thresholds={{ warn: 0.7, crit: 0.9 }}
      />,
    );
    expect(screen.getByText(/BASELINE 2026-06-20/)).toBeInTheDocument();
    expect(screen.queryByText(/⚠/)).toBeNull();
  });

  it('shows the cluster name and an accessible name summarizing status', () => {
    render(
      <ClusterTile entry={entry()} forecast={forecast()} thresholds={{ warn: 0.7, crit: 0.9 }} />,
    );
    expect(screen.getByText('CL-Prod-P1')).toBeInTheDocument();
    const link = screen.getByRole('link');
    expect(link.getAttribute('aria-label')).toContain('CL-Prod-P1');
    expect(link.getAttribute('aria-label')).toContain('2026-12-28');
  });

  it('renders a non-link error tile with a retry affordance when the entry failed to load', () => {
    render(
      <ClusterTile
        entry={entry({ error: 'Failed to load forecast', months: [] })}
        forecast={undefined}
        thresholds={{ warn: 0.7, crit: 0.9 }}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('CL-Prod-P1')).toBeInTheDocument();
    expect(screen.getByText(/forecast unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
