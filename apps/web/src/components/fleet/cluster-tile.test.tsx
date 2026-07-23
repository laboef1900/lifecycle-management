import type { ClusterResponse, ForecastMonthPoint, ForecastResponse } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
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
    eventAdds: '#176b45',
    eventConsumes: '#c0343c',
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
    Area: () => null,
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
    baselineHistory: [],
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

  it('shows an "ORDER BY ..." chip when there is a projected order-by date', () => {
    render(
      <ClusterTile entry={entry()} forecast={forecast()} thresholds={{ warn: 0.7, crit: 0.9 }} />,
    );
    // "Dec 28", not the raw "2026-12-28" ISO string (#243 Part B copy item 1)
    // — still uppercased to match the chip's own ALL-CAPS convention.
    const chip = screen.getByText(/ORDER BY DEC 28/);
    expect(chip).toBeInTheDocument();
    // #290: the relative-days suffix ("· IN X D" / "· X D OVERDUE") is
    // dropped from the visible chip label — the Badge's color tone already
    // conveys urgency, and the tile's aria-label still carries the
    // relative-days detail for assistive tech.
    expect(chip.textContent).toBe('ORDER BY DEC 28');
  });

  // Spec §4.4 amendment (2026-07-20, #268): the ORDER BY chip moved up to the
  // cluster-name row. #291 (2026-07-22) later removed the EVENT chip that had
  // shared this describe block entirely, rather than merely relocating it —
  // see the "EVENT chip removal (#291)" describe block below for its coverage.
  describe('chip placement (#268)', () => {
    const eventForecast = forecast({
      events: [
        {
          id: 'e1',
          effectiveDate: '2026-09-01',
          category: 'hardware',
          title: 'Decommission',
          description: null,
          consumptionDelta: null,
          capacityDelta: -2000,
        },
      ],
    });

    it('places the ORDER BY chip on the cluster-name row', () => {
      render(
        <ClusterTile entry={entry()} forecast={forecast()} thresholds={{ warn: 0.7, crit: 0.9 }} />,
      );
      const name = screen.getByText('CL-Prod-P1');
      const chip = screen.getByText(/ORDER BY DEC 28/);
      expect(chip.parentElement).toBe(name.parentElement);
    });

    it('drops the bottom flag row entirely when nothing is left to put in it', () => {
      // A fresh baseline and no provisional hosts leave the row empty. Rendering
      // it anyway would keep its `gap` height — the space the chart is meant to
      // reclaim — so absence, not emptiness, is the requirement. Still exercised
      // with a forecast carrying an event (#291: events no longer affect this
      // row at all, so this also guards against the bottom row reappearing).
      const { container } = render(
        <ClusterTile
          entry={entry()}
          forecast={eventForecast}
          thresholds={{ warn: 0.7, crit: 0.9 }}
        />,
      );
      expect(container.querySelector('.flex.flex-wrap.gap-1')).toBeNull();
    });

    it('still renders the flag row when a stale baseline needs it', () => {
      const { container } = render(
        <ClusterTile
          entry={entry({ cluster: cluster({ baselineDate: '2026-03-10' }) })}
          forecast={forecast()}
          thresholds={{ warn: 0.7, crit: 0.9 }}
        />,
      );
      expect(container.querySelector('.flex.flex-wrap.gap-1')).not.toBeNull();
      expect(screen.getByText(/BASELINE/)).toBeInTheDocument();
    });

    it("names events in the tile aria-label — the console's only event-in-window signal now that the visible EVENT chip is gone (#291)", () => {
      // The tile's aria-label OVERRIDES its visible content. Before #291 this
      // segment backstopped a visible-but-easily-missed chip; after #291 it is
      // the ONLY place the fleet console still surfaces this information.
      render(
        <ClusterTile
          entry={entry()}
          forecast={eventForecast}
          thresholds={{ warn: 0.7, crit: 0.9 }}
        />,
      );
      expect(screen.getByRole('link').getAttribute('aria-label')).toContain(
        '1 event in the forecast window',
      );
    });

    it('pluralizes the event count in the aria-label', () => {
      const twoEvents = forecast({
        events: [
          {
            id: 'e1',
            effectiveDate: '2026-09-01',
            category: 'hardware',
            title: 'Decommission',
            description: null,
            consumptionDelta: null,
            capacityDelta: -2000,
          },
          {
            id: 'e2',
            effectiveDate: '2026-10-01',
            category: 'hardware',
            title: 'Expansion',
            description: null,
            consumptionDelta: 500,
            capacityDelta: null,
          },
        ],
      });
      render(
        <ClusterTile entry={entry()} forecast={twoEvents} thresholds={{ warn: 0.7, crit: 0.9 }} />,
      );
      expect(screen.getByRole('link').getAttribute('aria-label')).toContain(
        '2 events in the forecast window',
      );
    });

    it('names no events in the aria-label when there are none', () => {
      render(
        <ClusterTile entry={entry()} forecast={forecast()} thresholds={{ warn: 0.7, crit: 0.9 }} />,
      );
      expect(screen.getByRole('link').getAttribute('aria-label')).not.toContain('event');
    });
  });

  // #291 (2026-07-22, owner decision): the fleet console's visible EVENT chip
  // is removed outright — the fleet console thereby has no visible
  // in-window event signal at all; only the aria-label (covered above) and
  // the cluster detail panel's ForecastChart still carry it.
  describe('EVENT chip removal (#291)', () => {
    it('never renders a visible EVENT chip, however many events the forecast carries', () => {
      const eventForecast = forecast({
        events: [
          {
            id: 'e1',
            effectiveDate: '2026-09-01',
            category: 'hardware',
            title: 'Decommission',
            description: null,
            consumptionDelta: null,
            capacityDelta: -2000,
          },
        ],
      });
      render(
        <ClusterTile
          entry={entry()}
          forecast={eventForecast}
          thresholds={{ warn: 0.7, crit: 0.9 }}
        />,
      );
      expect(screen.queryByText(/EVENT/)).toBeNull();
    });
  });

  it('aligns the runway sub-line with the numeral unit instead of nudging it up (#268)', () => {
    render(
      <ClusterTile entry={entry()} forecast={forecast()} thresholds={{ warn: 0.7, crit: 0.9 }} />,
    );
    const sub = screen.getByText(/past warn 70%/);
    // `pb-1` on an `items-end` row is what left the sub-line visibly stepped
    // above the 'mo' it qualifies; baseline alignment on the row replaces it.
    expect(sub.className).not.toMatch(/pb-1/);
    expect(sub.parentElement?.className).toMatch(/items-baseline/);
  });

  it('labels the runway numeral unit in lowercase "mo", matching RunwayPill and the fleet verdict (#243 Part B copy item 2)', () => {
    render(
      <ClusterTile entry={entry()} forecast={forecast()} thresholds={{ warn: 0.7, crit: 0.9 }} />,
    );
    expect(screen.getByText('mo', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('MO', { exact: true })).toBeNull();
  });

  // Spec §4.4 amendment (2026-07-19, #243 Part B): a healthy tile restated
  // the all-clear four ways (OK badge, "24+ mo no breach", this chip, and a
  // baseline chip repeating the same date on every tile) — the one tile that
  // someday reads ORDER BY wouldn't stand out. The order chip now renders
  // only when there is something to say: a real order-by date, or the
  // unknown-capacity case (covered separately below).
  it('omits the order chip entirely when there is no projected order-by date and capacity is known', () => {
    render(
      <ClusterTile
        entry={entry()}
        forecast={forecast({
          procurement: { leadTimeWeeks: 13, orderByDate: null, breachMonth: null },
        })}
        thresholds={{ warn: 0.7, crit: 0.9 }}
      />,
    );
    expect(screen.queryByText(/no order needed/i)).toBeNull();
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

  // Same spec §4.4 amendment as above: the baseline chip is now shown only
  // in its stale/warn variant — a fresh baseline repeating its date on every
  // tile added no information the "BASELINES ✓ all fresh" verdict instrument
  // didn't already state.
  it('omits the baseline chip entirely for a fresh baseline', () => {
    render(
      <ClusterTile
        entry={entry({ cluster: cluster({ baselineDate: '2026-06-20' }) })}
        forecast={forecast()}
        thresholds={{ warn: 0.7, crit: 0.9 }}
      />,
    );
    expect(screen.queryByText(/BASELINE 2026-06-20/)).toBeNull();
    expect(screen.queryByText(/⚠/)).toBeNull();
  });

  it('shows the cluster name and an accessible name summarizing status', () => {
    render(
      <ClusterTile entry={entry()} forecast={forecast()} thresholds={{ warn: 0.7, crit: 0.9 }} />,
    );
    expect(screen.getByText('CL-Prod-P1')).toBeInTheDocument();
    const link = screen.getByRole('link');
    expect(link.getAttribute('aria-label')).toContain('CL-Prod-P1');
    // "Dec 28", not the raw ISO string (#243 Part B copy item 1) — the
    // aria-label's own sentence-style casing, unlike the visible chip's caps.
    expect(link.getAttribute('aria-label')).toContain('Dec 28');
    expect(link.getAttribute('aria-label')).not.toContain('2026-12-28');
  });

  it('renders an "unknown" state for a zero-capacity cluster, never "0.0% used" (#200)', () => {
    const unknownMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 500, capacity: 0, utilization: null },
      { month: '2026-08-01', consumption: 550, capacity: 0, utilization: null },
    ];
    render(
      <ClusterTile
        entry={entry({
          cluster: cluster({
            metrics: [
              {
                metricTypeKey: 'memory_gb',
                metricTypeDisplayName: 'Memory',
                unit: 'GB',
                baselineConsumption: 0,
                baselineCapacity: 0,
                currentConsumption: 0,
                currentCapacity: 0,
                utilization: null,
              },
            ],
          }),
          months: unknownMonths,
          summary: { months: null, alreadyBreached: false },
        })}
        forecast={forecast({
          months: unknownMonths,
          procurement: { leadTimeWeeks: 13, orderByDate: null, breachMonth: null },
        })}
        thresholds={{ warn: 0.7, crit: 0.9 }}
      />,
    );
    // The 0%-lie must never reach a purchasing surface.
    expect(screen.queryByText(/0\.0% used/)).toBeNull();
    // A text-carried "unknown" badge (not color-only), and no green/amber verdict badge.
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText('OK')).toBeNull();
    expect(screen.queryByText('WARN')).toBeNull();
    // Assistive tech hears "unknown", never "0 percent utilized".
    const link = screen.getByRole('link');
    expect(link.getAttribute('aria-label')).toMatch(/utilization unknown/i);
    expect(link.getAttribute('aria-label')).toMatch(/runway unknown/i);
    expect(link.getAttribute('aria-label')).toMatch(/order status unknown/i);
    expect(link.getAttribute('aria-label')).not.toMatch(/0 percent utilized/);
    expect(screen.getByText(/capacity unknown/i)).toBeInTheDocument();
    expect(screen.getByText(/order status unknown/i)).toBeInTheDocument();
    expect(screen.queryByText(/no breach/i)).toBeNull();
    expect(screen.queryByText(/no order needed/i)).toBeNull();
    expect(link).not.toHaveTextContent(/\d+\+? mo/i);
    // Finding: the verdict named the problem ("runway and breach timing
    // cannot be calculated") but never the fix — the Hosts tab is the only
    // path off this state for a synced cluster with no recorded capacity.
    expect(screen.getByText(/add host capacity to calculate runway/i)).toBeInTheDocument();
    // The a11y path names the same fix. aria-label overrides the tile's
    // visible content, so a screen-reader user who only heard "capacity
    // required" would be left in exactly the dead end this item removes.
    expect(link.getAttribute('aria-label')).toMatch(/add host capacity/i);
    expect(link.getAttribute('aria-label')).not.toMatch(/capacity required to calculate/i);
  });

  it('reflects an already-past-warn breach in the runway sub-line, badge, and verdict when crit is never reached in-window (finding 1)', () => {
    // Default entry() fixture: summary.alreadyBreached === 'warn', and both
    // months (0.777, 0.79) stay under the 0.9 crit threshold — crit is never
    // reached in-window.
    render(
      <ClusterTile entry={entry()} forecast={forecast()} thresholds={{ warn: 0.7, crit: 0.9 }} />,
    );
    expect(screen.getByText('WARN')).toBeInTheDocument();
    expect(screen.getByText(/past warn 70%/i)).toBeInTheDocument();
    expect(screen.getByText(/crit beyond window/i)).toBeInTheDocument();
    expect(screen.queryByText(/no breach/i)).toBeNull();
    expect(
      screen.getByText(/already past warn; crit beyond the 2-month window/i),
    ).toBeInTheDocument();
  });

  it('reflects an already-past-crit breach analogously when crit is never crossed again in-window (finding 1, crit variant)', () => {
    // summary.alreadyBreached is 'crit' (current month already over crit), but
    // none of the in-window months (both under the 0.9 crit threshold) cross
    // crit again — the defensive "no further crossing" branch for crit.
    render(
      <ClusterTile
        entry={entry({
          cluster: cluster({
            metrics: [
              {
                metricTypeKey: 'memory_gb',
                metricTypeDisplayName: 'Memory',
                unit: 'GB',
                baselineConsumption: 22900,
                baselineCapacity: 24576,
                currentConsumption: 22900,
                currentCapacity: 24576,
                utilization: 0.932,
              },
            ],
          }),
          summary: { months: 0, alreadyBreached: 'crit' },
        })}
        forecast={forecast()}
        thresholds={{ warn: 0.7, crit: 0.9 }}
      />,
    );
    expect(screen.getByText('CRIT')).toBeInTheDocument();
    expect(screen.getByText(/past crit 90%/i)).toBeInTheDocument();
    expect(screen.queryByText(/no breach/i)).toBeNull();
    expect(screen.getByText(/already past crit/i)).toBeInTheDocument();
  });

  it('shows past-warn numeral treatment — not a "to crit" countdown — when already past warn and crit is reached in-window (PR review fix 2)', () => {
    // summary.alreadyBreached is 'warn' (current month already over warn,
    // under crit) but a later in-window month (index 1) crosses crit. Per
    // the spec's recorded amendment, the numeral must keep tracking warn
    // (the same "{horizon}+ mo" treatment as when crit is never reached) —
    // crit surfaces only in the sub-line/verdict, never promotes the
    // numeral to a "to crit" countdown. Otherwise the numeral (which reads
    // as a countdown to crit) contradicts the panel's RunwayPill, which
    // reports "Over 70%" (warn) semantics for this exact state.
    const pastWarnCritInWindowMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 18000, capacity: 24576, utilization: 18000 / 24576 },
      { month: '2026-08-01', consumption: 22500, capacity: 24576, utilization: 22500 / 24576 },
    ];
    render(
      <ClusterTile
        entry={entry({
          months: pastWarnCritInWindowMonths,
          summary: { months: 0, alreadyBreached: 'warn' },
        })}
        forecast={forecast()}
        thresholds={{ warn: 0.7, crit: 0.9 }}
      />,
    );
    expect(screen.getByText('WARN')).toBeInTheDocument();
    expect(screen.getByText(/past warn 70% — crit ≈ Aug 26/i)).toBeInTheDocument();
    expect(screen.getByText(/already past warn; reaches crit ≈ Aug 26/i)).toBeInTheDocument();
    expect(screen.queryByText(/to crit/i)).toBeNull();
  });

  it('renders an em dash instead of a synthetic "0+ mo" for an archived cluster with no forecast (finding 3)', () => {
    render(
      <ClusterTile
        entry={{
          cluster: cluster({ archivedAt: '2026-01-01T00:00:00Z' }),
          months: [],
          thresholds: { warn: 0.7, crit: 0.9 },
          summary: { months: null, alreadyBreached: false },
        }}
        forecast={undefined}
        thresholds={{ warn: 0.7, crit: 0.9 }}
      />,
    );
    const archivedBadge = screen.getByText('Archived');
    expect(archivedBadge).toBeInTheDocument();
    // Icon + text on the badge (#243, WCAG 1.4.1): the tile's dimming is
    // never the only archived signal.
    expect(archivedBadge.querySelector('svg')).not.toBeNull();
    expect(screen.getByLabelText('archived — no forecast')).toHaveTextContent('—');
    const link = screen.getByRole('link');
    expect(link).not.toHaveTextContent('0+');
    expect(link.getAttribute('aria-label')).toContain('archived — no forecast');
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

  const syncedConnection = {
    id: 'conn1',
    name: 'vc-prod-zrh',
    status: 'active' as const,
    enabled: true,
  };

  it('a manual cluster shows no sync badge or live line (unchanged appearance)', () => {
    render(
      <ClusterTile entry={entry()} forecast={forecast()} thresholds={{ warn: 0.7, crit: 0.9 }} />,
    );
    expect(screen.queryByText('vSphere')).toBeNull();
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  it('a synced cluster renders the vSphere badge, live reading, and an AT summary', () => {
    render(
      <ClusterTile
        entry={entry({ cluster: cluster({ source: 'vsphere', connection: syncedConnection }) })}
        forecast={forecast()}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        live={{
          state: 'fresh',
          clusterId: 'c1',
          connectionName: 'vc-prod-zrh',
          memoryUsedGiB: 1234.5,
          hostsSampled: 8,
          hostsTotal: 8,
          measuredAt: '2026-08-01T11:59:00Z',
          ageSeconds: 120,
        }}
      />,
    );
    expect(screen.getByText('vSphere')).toBeInTheDocument();
    expect(screen.getByText('1,235 GiB')).toBeInTheDocument();
    // aria-label overrides visible content, so the live info must be echoed there.
    const label = screen.getByRole('link').getAttribute('aria-label') ?? '';
    expect(label).toContain('synced from vSphere');
    expect(label).toContain('1,235 GiB');
  });

  it('★ a synced cluster with no sample reads "not yet measured", never 0', () => {
    render(
      <ClusterTile
        entry={entry({ cluster: cluster({ source: 'vsphere', connection: syncedConnection }) })}
        forecast={forecast()}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        live={{ state: 'never_fetched', clusterId: 'c1', connectionName: 'vc-prod-zrh' }}
      />,
    );
    expect(screen.getByText('not yet measured')).toBeInTheDocument();
    expect(screen.queryByText(/0 GiB/)).toBeNull();
  });

  it('surfaces the provisional-host hint when hosts need commissioning dates', () => {
    render(
      <ClusterTile
        entry={entry({
          cluster: cluster({
            source: 'vsphere',
            connection: syncedConnection,
            provisionalHostCount: 4,
          }),
        })}
        forecast={forecast()}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        live={{ state: 'never_fetched', clusterId: 'c1', connectionName: 'vc-prod-zrh' }}
      />,
    );
    expect(screen.getByText(/4 HOSTS NEED DATES/)).toBeInTheDocument();
  });

  it('describes a genuinely healthy runway with the raw horizon length, not the numeral\'s "+" (finding: "24+-month window")', () => {
    // A cluster that never crosses warn/crit anywhere in-window: distinct
    // from the default entry() fixture (already past warn) and from the
    // past-warn/past-crit fixtures above — this is computeRunway's final,
    // genuinely-unbreached branch, where `plus` is always true because the
    // numeral itself is an open-ended "{horizon}+ mo" countdown. The
    // window-boundary sentence describes a fixed fact (the window is
    // exactly `horizon` months long) and must not inherit that "+".
    const healthyMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 12000, capacity: 24576, utilization: 12000 / 24576 },
      { month: '2026-08-01', consumption: 12200, capacity: 24576, utilization: 12200 / 24576 },
    ];
    render(
      <ClusterTile
        entry={entry({ months: healthyMonths, summary: { months: null, alreadyBreached: false } })}
        forecast={forecast({ months: healthyMonths })}
        thresholds={{ warn: 0.7, crit: 0.9 }}
      />,
    );
    expect(screen.getByText(/no breach in the 2-month window/i)).toBeInTheDocument();
    expect(screen.queryByText(/2\+-month window/i)).toBeNull();
  });

  // #302 (follow-up to #292/#300): the order-approval acknowledgment must
  // also surface on the fleet console tile, not just the cluster detail
  // panel's `RecommendationChip`. Reuses that exact component (same icon,
  // same data, same testid) rather than inventing a new tile-only pattern.
  describe('order-approval acknowledgment (#302)', () => {
    const ack = {
      note: 'PO raised — 2 nodes',
      approvedByLabel: 'Ada Admin',
      approvedAt: '2026-07-14T09:00:00.000Z',
    };

    it('shows the Acknowledged annotation on the tile when the forecast carries a covering approval', () => {
      render(
        <TooltipProvider>
          <ClusterTile
            entry={entry()}
            forecast={forecast({ acknowledgment: ack })}
            thresholds={{ warn: 0.7, crit: 0.9 }}
          />
        </TooltipProvider>,
      );

      // Same testid/component as RecommendationChip's detail-panel treatment
      // (recommendation-chip.tsx) — this IS that component, reused.
      const badge = screen.getByTestId('recommendation-acknowledged');
      expect(badge).toHaveTextContent('Ada Admin');
      expect(badge).toHaveTextContent('PO raised — 2 nodes');
      // Never color alone: an icon accompanies the text (WCAG 1.4.1).
      expect(badge.querySelector('svg')).not.toBeNull();
    });

    it("names the acknowledgment in the tile aria-label, since aria-label overrides the tile's visible content", () => {
      render(
        <TooltipProvider>
          <ClusterTile
            entry={entry()}
            forecast={forecast({ acknowledgment: ack })}
            thresholds={{ warn: 0.7, crit: 0.9 }}
          />
        </TooltipProvider>,
      );

      expect(screen.getByRole('link').getAttribute('aria-label')).toContain(
        'order acknowledged by Ada Admin',
      );
    });

    it('omits the Acknowledged annotation entirely when there is no covering approval (not-yet-acknowledged state)', () => {
      render(
        <ClusterTile entry={entry()} forecast={forecast()} thresholds={{ warn: 0.7, crit: 0.9 }} />,
      );

      expect(screen.queryByTestId('recommendation-acknowledged')).toBeNull();
      expect(screen.getByRole('link').getAttribute('aria-label')).not.toContain('acknowledged');
    });
  });

  // Finding: sub-10px micro text on tiles violates the design system's own
  // --text-label 10px floor (styles.css). Contrast passes, but 9px uppercase
  // tracked mono is hard to read on the primary console. This tile's own
  // portion: the order chip (was 9.5px) and FlagChip (was 9px).
  describe('micro-text floor', () => {
    // #290: the order chip now renders via the shared `Badge` (`text-xs` =
    // 12px), which clears the design system's 10px --text-label floor but no
    // longer literally matches the old bespoke `text-[10px]` class.
    it('renders the order chip via the shared Badge at text-xs (12px), clearing the 10px floor', () => {
      render(
        <ClusterTile entry={entry()} forecast={forecast()} thresholds={{ warn: 0.7, crit: 0.9 }} />,
      );
      const chip = screen.getByText(/ORDER BY DEC 28/);
      expect(chip.className).toMatch(/text-xs/);
      expect(chip.className).not.toMatch(/text-\[9\.5px\]/);
      expect(chip.className).not.toMatch(/text-\[10px\]/);
    });

    // Re-pointed at the stale-baseline chip (#291): the EVENT chip this test
    // originally floored was removed from the tile, but FlagChip itself is
    // still rendered here, so the 10px floor still needs a live assertion.
    it('floors the FlagChip at 10px, not 9px', () => {
      render(
        <ClusterTile
          entry={entry({ cluster: cluster({ baselineDate: '2026-03-10' }) })}
          forecast={forecast()}
          thresholds={{ warn: 0.7, crit: 0.9 }}
        />,
      );
      const chip = screen.getByText(/⚠ BASELINE/);
      expect(chip.className).toMatch(/text-\[10px\]/);
      expect(chip.className).not.toMatch(/text-\[9px\]/);
    });
  });
});
