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
    utilization: capacity > 0 ? consumption / capacity : null,
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
    // Rescoped from "no orders due before <month>" (finding: the horizon-edge
    // date read as a guarantee it can't back up — a breach shortly past the
    // horizon, minus lead time, could still demand an order before that
    // date). The window duration comes from the real aggregated series
    // length (2, in this fixture's summary()), not a hardcoded "24".
    expect(heading).toHaveTextContent(/no orders due in the 2-month forecast window/i);
    expect(heading).not.toHaveTextContent(/no orders due before/i);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('never underlines the non-link emphasis in the headline — only a real <Link> gets the link-styled underline', () => {
    // All three headline forms exercise this: the all-clear form has no
    // Link at all, so every <strong> here must read as plain colored
    // emphasis, never as a dead clickable-looking target (finding:
    // "healthy" and the horizon read identically to the urgent branch's
    // actual cluster-name <Link>).
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
    for (const strong of heading.querySelectorAll('strong')) {
      expect(strong.className).not.toMatch(/underline/);
    }
  });

  it('keeps the underline on the real cluster-name link in the urgent headline, while its sibling <strong>s stay unlined', () => {
    render(
      <FleetVerdict
        summary={summary()}
        earliest={{ cluster: cluster('c1', 'CL-Oracle'), procurement: procurement() }}
        staleCount={0}
        openOrderCount={1}
        hostCount={null}
      />,
    );
    const link = screen.getByRole('link', { name: 'CL-Oracle' });
    expect(link.className).toMatch(/underline/);
    const heading = screen.getByRole('heading', { level: 1 });
    for (const strong of heading.querySelectorAll('strong')) {
      expect(strong.className).not.toMatch(/underline/);
    }
  });

  it('renders an explicit unknown state when fleet capacity is incomplete', () => {
    render(
      <FleetVerdict
        summary={summary({
          totalConsumption: 500,
          totalCapacity: 0,
          utilization: null,
          worstCluster: null,
          perClusterSeries: [
            {
              clusterId: 'c1',
              clusterName: 'CL-Oracle',
              months: months([['2026-07-01', 500, 0]]),
            },
          ],
          fleetMonths: [{ month: '2026-07-01', capacityTotal: 0 }],
        })}
        earliest={null}
        staleCount={0}
        openOrderCount={0}
        hostCount={null}
      />,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      /fleet capacity is unknown/i,
    );
    expect(screen.queryByText(/fleet is healthy/i)).toBeNull();
    expect(screen.queryByText(/no orders due/i)).toBeNull();
    expect(screen.getAllByText('UNKNOWN')).toHaveLength(2);
    expect(screen.getByText('status unknown')).toBeInTheDocument();
    expect(screen.queryByText('0.0%')).toBeNull();
    expect(screen.queryByLabelText(/fleet utilization/i)).toBeNull();
  });

  it('preserves a known urgent order without inventing fleet runway when another capacity is unknown', () => {
    render(
      <FleetVerdict
        summary={summary({ utilization: null })}
        earliest={{ cluster: cluster('c1', 'CL-Oracle'), procurement: procurement() }}
        staleCount={0}
        openOrderCount={1}
        hostCount={null}
      />,
    );

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(/fleet capacity is unknown/i);
    expect(heading).toHaveTextContent(/CL-Oracle still needs an order by Sep 14/i);
    expect(heading).not.toHaveTextContent(/fleet runway is/i);
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

  // Finding: standalone <Separator /> flex items strand a dangling divider
  // with nothing after it when the row wraps at 768px, because the divider
  // is an independent flex child rather than part of the instrument it sits
  // beside. Fixed by drawing dividers structurally (attached to each
  // instrument) instead of as separate elements.
  it('draws instrument dividers structurally instead of standalone separator elements', () => {
    const { container } = render(
      <FleetVerdict
        summary={summary()}
        earliest={null}
        staleCount={0}
        openOrderCount={0}
        hostCount={null}
      />,
    );
    // The old standalone divider was a fixed-height hairline span
    // (`h-8 w-px`); none should remain as independent flex items.
    expect(container.querySelectorAll('.w-px')).toHaveLength(0);
    const row = screen.getByText('Utilization').closest('div')?.parentElement;
    expect(row).not.toBeNull();
    // The rule goes on EVERY instrument, and the row is offset inside an
    // overflow-hidden wrapper so whichever instrument starts a visual row
    // has its leading rule clipped. Assert the offset and the wrapper, not
    // merely that "border-l" appears somewhere: jsdom never evaluates an
    // arbitrary variant, so a bare substring match would pass just as
    // happily for the `*+*` form, which orphans a rule at the start of
    // every wrapped row instead of the end of the one before it.
    expect(row?.className).toContain('sm:[&>*]:border-l');
    expect(row?.className).toContain('-mx-6');
    expect(row?.className).not.toContain('[&>*+*]:');
    expect(row?.parentElement?.className).toContain('overflow-hidden');
    expect(row?.children).toHaveLength(5);
  });

  it('falls back to an unnumbered window phrase when no forecast series has loaded', () => {
    // Reachable whenever clusters carry recorded capacity but every forecast
    // lookup misses (aggregate-fleet falls back to `?? []` per cluster): the
    // healthy branch still renders, and interpolating the raw series length
    // would print "no orders due in the 0-month forecast window."
    render(
      <FleetVerdict
        summary={{ ...summary(), fleetMonths: [] }}
        earliest={null}
        staleCount={0}
        openOrderCount={0}
        hostCount={null}
      />,
    );
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(/no orders due in the forecast window/i);
    expect(heading).not.toHaveTextContent(/0-month/);
  });

  // Finding: "Type-scale tokens defined but unused; Settings h1 drops the
  // display font" — three sibling top-level headings (verdict, Settings,
  // panel title) each carried their own arbitrary size instead of the
  // shared --text-display/--text-h1 tokens. This is the verdict h1's half.
  it('adopts the shared text-display token instead of its own arbitrary clamp/leading/tracking', () => {
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
    expect(heading).toHaveClass('font-display', 'text-display');
    expect(heading.className).not.toMatch(/text-\[clamp/);
    expect(heading.className).not.toMatch(/leading-\[1\.18\]/);
    expect(heading.className).not.toMatch(/tracking-\[-0\.02em\]/);
  });
});
