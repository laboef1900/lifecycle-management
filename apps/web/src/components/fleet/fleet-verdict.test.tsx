import type { ClusterResponse, ForecastMonthPoint, ProcurementInfo } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FleetSummary } from '@/lib/aggregate-fleet';

import { FleetVerdict } from './fleet-verdict';

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

vi.mock('@/lib/use-effective-thresholds', () => ({
  useEffectiveThresholds: () => ({ warn: 0.7, crit: 0.9, source: 'system' }),
}));

function cluster(id: string, name: string): ClusterResponse {
  return {
    id,
    name,
    description: null,
    baselineDate: '2026-06-01',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    archivedAt: null,
    metrics: [],
  };
}

function months(values: Array<[string, number, number]>): ForecastMonthPoint[] {
  return values.map(([month, consumption, capacity]) => ({
    month,
    consumption,
    capacity,
    utilization: capacity > 0 ? consumption / capacity : 0,
  }));
}

function summary(overrides: Partial<FleetSummary> = {}): FleetSummary {
  return {
    totalConsumption: 6200,
    totalCapacity: 10000,
    utilization: 0.62,
    clusterCount: 2,
    worstCluster: { id: 'c1', name: 'CL-Oracle', utilization: 0.84 },
    perClusterSeries: [
      {
        clusterId: 'c1',
        clusterName: 'CL-Oracle',
        months: months([
          ['2026-07-01', 3440, 4096],
          ['2026-08-01', 3485, 4096],
        ]),
      },
      {
        clusterId: 'c2',
        clusterName: 'CL-P1',
        months: months([
          ['2026-07-01', 2760, 5904],
          ['2026-08-01', 2900, 5904],
        ]),
      },
    ],
    fleetMonths: [
      { month: '2026-07-01', capacityTotal: 10000 },
      { month: '2026-08-01', capacityTotal: 10000 },
    ],
    ...overrides,
  };
}

function procurement(overrides: Partial<ProcurementInfo> = {}): ProcurementInfo {
  return { leadTimeWeeks: 13, orderByDate: '2026-09-14', breachMonth: '2026-12-01', ...overrides };
}

describe('<FleetVerdict>', () => {
  it('renders the urgent sentence with the cluster name and order-by date when there is a breach', () => {
    render(
      <FleetVerdict
        summary={summary()}
        earliest={{ cluster: cluster('c1', 'CL-Oracle'), procurement: procurement() }}
        staleCount={0}
        openOrderCount={1}
        hostCount={null}
      />,
    );
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(/fleet runway is/i);
    expect(heading).toHaveTextContent(/needs an order by/i);
    expect(screen.getByRole('link', { name: 'CL-Oracle' })).toHaveAttribute('href', '/clusters/c1');
    expect(screen.getByText('Sep 14')).toBeInTheDocument();
  });

  it('renders "{horizon}+ mo" — not "0 mo" — when a cluster is urgent but the fleet-wide aggregate never breaches (PR review fix 1)', () => {
    // The flagship fixture: c1 alone is individually at 84%/85% utilization
    // (`earliest` below), but the fleet-wide aggregate (consumption summed
    // across both clusters, divided by summed capacity) stays under the 70%
    // warn threshold for both months in `summary()`'s 2-month series — so
    // `fleetRunwayToWarn` never breaches (months: null, alreadyBreached:
    // false). The old `runwayMonths()` coerced that `null` to 0 via `?? 0`,
    // rendering the nonsensical "Fleet runway is 0 mo". The horizon (here 2,
    // matching `summary().fleetMonths.length`) must come from the actual
    // aggregated series length, not a hardcoded constant.
    render(
      <FleetVerdict
        summary={summary()}
        earliest={{ cluster: cluster('c1', 'CL-Oracle'), procurement: procurement() }}
        staleCount={0}
        openOrderCount={1}
        hostCount={null}
      />,
    );
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(/fleet runway is 2\+ mo/i);
    expect(heading).not.toHaveTextContent(/fleet runway is 0 mo/i);
  });

  it('renders the real breach month number (no "+") when the fleet-wide aggregate itself crosses warn', () => {
    // Distinct from the "+" case above: here the aggregate (not just one
    // cluster) crosses the 70% warn threshold at month index 1 (consumption
    // 4700+2900=7600 / capacity 4096+5904=10000 = 76%), so
    // `fleetRunwayToWarn` resolves a real index and the numeral must render
    // that index verbatim, not a horizon-derived "+" figure.
    const breachingSummary = summary({
      perClusterSeries: [
        {
          clusterId: 'c1',
          clusterName: 'CL-Oracle',
          months: months([
            ['2026-07-01', 3440, 4096],
            ['2026-08-01', 4700, 4096],
          ]),
        },
        {
          clusterId: 'c2',
          clusterName: 'CL-P1',
          months: months([
            ['2026-07-01', 2760, 5904],
            ['2026-08-01', 2900, 5904],
          ]),
        },
      ],
    });
    render(
      <FleetVerdict
        summary={breachingSummary}
        earliest={{ cluster: cluster('c1', 'CL-Oracle'), procurement: procurement() }}
        staleCount={0}
        openOrderCount={1}
        hostCount={null}
      />,
    );
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(/fleet runway is 1 mo/i);
  });

  it('renders the all-clear sentence when there is no projected breach', () => {
    render(
      <FleetVerdict
        summary={summary()}
        earliest={null}
        staleCount={0}
        openOrderCount={0}
        hostCount={null}
      />,
    );
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(/fleet is healthy/i);
    expect(heading).toHaveTextContent(/no orders due before/i);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders the verdict headline as the page h1', () => {
    render(
      <FleetVerdict
        summary={summary()}
        earliest={null}
        staleCount={0}
        openOrderCount={0}
        hostCount={null}
      />,
    );
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('shows a warn-toned stale-baseline count when > 0', () => {
    render(
      <FleetVerdict
        summary={summary()}
        earliest={null}
        staleCount={2}
        openOrderCount={0}
        hostCount={null}
      />,
    );
    expect(screen.getByText(/2 stale/i)).toBeInTheDocument();
  });

  it('shows "all fresh" when no baselines are stale', () => {
    render(
      <FleetVerdict
        summary={summary()}
        earliest={null}
        staleCount={0}
        openOrderCount={0}
        hostCount={null}
      />,
    );
    expect(screen.getByText(/all fresh/i)).toBeInTheDocument();
  });

  it('shows the fleet utilization percentage and clusters count', () => {
    render(
      <FleetVerdict
        summary={summary()}
        earliest={null}
        staleCount={0}
        openOrderCount={0}
        hostCount={null}
      />,
    );
    expect(screen.getByText('62.0%')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows "N CLUSTERS · M HOSTS" once the host count has resolved (finding 2)', () => {
    render(
      <FleetVerdict
        summary={summary()}
        earliest={null}
        staleCount={0}
        openOrderCount={0}
        hostCount={28}
      />,
    );
    expect(screen.getByText('2 CLUSTERS · 28 HOSTS')).toBeInTheDocument();
  });

  it('shows the cluster count alone (no host count) while forecasts are still loading', () => {
    render(
      <FleetVerdict
        summary={summary()}
        earliest={null}
        staleCount={0}
        openOrderCount={0}
        hostCount={null}
      />,
    );
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText(/HOSTS/)).toBeNull();
  });
});
