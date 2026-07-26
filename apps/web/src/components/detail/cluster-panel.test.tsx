import type { ClusterResponse, ForecastResponse, HostResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { api } from '@/lib/api-client';
import { todayIso } from '@/lib/format';

import {
  ClusterPanel,
  collectFocusable,
  computeScenarioDeltaLabel,
  deriveBlockedPresets,
  isEscapeTargetInsidePanel,
  resolvePresentKpi,
  scenarioChangesNothing,
} from './cluster-panel';

const CLUSTER_ID = 'cl-1';

/**
 * The panel reads two viewport breakpoints (`640px` for the compact chart,
 * `1024px` for whether the Scenario rail docks beside the content column or
 * stacks inline under the chart). The shared setup stub answers `false` to
 * every query, i.e. the narrowest viewport — good for the inline cases,
 * useless for the docked ones, so tests that care state a width.
 */
function stubViewportWidth(width: number): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => {
      const minWidth = /min-width:\s*(\d+)px/.exec(query)?.[1];
      return {
        matches: minWidth === undefined ? false : width >= Number(minWidth),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      };
    }),
  );
}

const navigateMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  // Minimal Link stand-in for the BackLink (#243): renders the real anchor
  // semantics the component promises (href, ref, aria attributes) without
  // router context. SPA navigation on click is TanStack's own behavior and is
  // covered by the Playwright suite against a real router.
  Link: ({
    to,
    children,
    ref,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    ref?: React.Ref<HTMLAnchorElement>;
  }) => (
    <a href={to} ref={ref} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/auth', () => ({
  useIsAdmin: () => false,
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
    LabelList: () => null,
    ReferenceLine: () => null,
    ReferenceDot: () => null,
  };
});

function cluster(overrides: Partial<ClusterResponse> = {}): ClusterResponse {
  return {
    id: CLUSTER_ID,
    name: 'Prod-East',
    description: 'Primary production cluster',
    baselineDate: '2026-06-01',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archivedAt: null,
    metrics: [
      {
        metricTypeKey: 'memory_gb',
        metricTypeDisplayName: 'Memory',
        unit: 'GB',
        baselineConsumption: 400,
        baselineCapacity: 1000,
        currentConsumption: 500,
        currentCapacity: 1000,
        utilization: 0.5,
      },
    ],
    ...overrides,
  };
}

/**
 * A month label N months from the CURRENT month, in the forecast's own
 * `YYYY-MM-01` shape. The panel's present-tense KPIs look up `todayIso()` on the
 * active forecast, so hardcoded fixture months would silently stop exercising
 * that path the moment the calendar moved past them — every assertion would
 * still pass, against the fallback.
 */
function monthFromNow(offset: number): string {
  const start = new Date(`${todayIso()}T00:00:00Z`);
  const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1));
  return `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** One forecast point, `offset` months from the current month. */
function monthPoint(
  offset: number,
  consumption: number,
  capacity: number,
): ForecastResponse['months'][number] {
  return {
    month: monthFromNow(offset),
    consumption,
    capacity,
    utilization: capacity === 0 ? null : consumption / capacity,
  };
}

/**
 * Tracked hosts that each contribute real capacity. A host contributing 0 to
 * every month is a host whose capacity was never recorded — dropping it cannot
 * move the forecast, which is exactly what makes the "Lose hosts" preset
 * inapplicable, so fixtures that want the preset available must say so.
 */
function hostsWithCapacity(count: number, amount = 500): ForecastResponse['hosts'] {
  return Array.from({ length: count }, (_, i) => ({
    id: `h${i + 1}`,
    name: `h${i + 1}`,
    contributions: [{ month: monthFromNow(0), amount }],
  }));
}

function forecast(overrides: Partial<ForecastResponse> = {}): ForecastResponse {
  return {
    fromMonth: monthFromNow(0),
    toMonth: monthFromNow(2),
    months: [monthPoint(0, 500, 1000), monthPoint(1, 550, 1000), monthPoint(2, 600, 1000)],
    events: [],
    hosts: hostsWithCapacity(1, 1000),
    applications: [],
    effectiveThresholds: { warn: 0.7, crit: 0.9, source: 'tenant' },
    procurement: { leadTimeWeeks: 6, orderByDate: null, breachMonth: null },
    baselineHistory: [],
    ...overrides,
  };
}

function makeHost(overrides: Partial<HostResponse> = {}): HostResponse {
  return {
    id: 'host-1',
    clusterId: CLUSTER_ID,
    name: 'esx-01',
    description: null,
    commissionedAt: '2024-03-15',
    decommissionedAt: null,
    serialNumber: null,
    vendor: null,
    model: null,
    purchasedAt: null,
    warrantyEndsAt: '2027-03-15',
    eolAt: '2029-03-15',
    runPastEol: false,
    state: 'in_service',
    projectedDecommissionAt: null,
    createdAt: '2024-03-15T00:00:00.000Z',
    updatedAt: '2024-03-15T00:00:00.000Z',
    capacities: [],
    ...overrides,
  };
}

function Harness({ show }: { show: boolean }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      {/* app.tsx mounts TooltipProvider app-wide; the BackLink and
          recommendation chip (#243) render Radix Tooltips that need it. */}
      <TooltipProvider>
        <button type="button">Open trigger</button>
        {show ? <ClusterPanel clusterId={CLUSTER_ID} /> : null}
      </TooltipProvider>
    </QueryClientProvider>
  );
}

describe('<ClusterPanel>', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    vi.spyOn(api.clusters, 'get').mockResolvedValue(cluster());
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(forecast());
    // The default cluster() is manual (no connection), so the live-usage
    // section renders nothing — but the batch query still fires; keep it off
    // the real network (#193).
    vi.spyOn(api.clusters, 'liveUsage').mockResolvedValue({ items: [] });
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [],
      total: 0,
      limit: 500,
      offset: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders as a modal dialog and moves focus to the back button on open (PR review fix 3)', async () => {
    // aria-modal="true" now matches reality: the route wraps the fleet
    // console in an `inert` container while this panel is open (see
    // apps/web/src/routes/_app.clusters.$id.tsx), and the hand-rolled Tab
    // trap below already scoped focus to the panel — aria-modal="false" was
    // a contradiction, not a deliberate design choice.
    render(<Harness show />);

    await waitFor(() => {
      expect(screen.getByTestId('panel-back-link')).toHaveFocus();
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('shows "unknown" (never 0.0%) for the current utilization of a zero-capacity cluster (#200)', async () => {
    vi.spyOn(api.clusters, 'get').mockResolvedValue(
      cluster({
        metrics: [
          {
            metricTypeKey: 'memory_gb',
            metricTypeDisplayName: 'Memory',
            unit: 'GB',
            baselineConsumption: 500,
            baselineCapacity: 0,
            currentConsumption: 500,
            currentCapacity: 0,
            utilization: null,
          },
        ],
      }),
    );
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(
      forecast({ months: [monthPoint(0, 500, 0), monthPoint(1, 550, 0)] }),
    );

    render(<Harness show />);
    const strip = await screen.findByTestId('kpi-strip');
    // The 0%-lie must never render on the purchasing-decision KPI strip.
    expect(strip).not.toHaveTextContent('0.0%');
    // A text-carried "unknown" reason, not color alone — now three tiles
    // (Utilization, Headroom, and Runway since #243 Part B item 2, which
    // moved Runway onto the same KpiTile grammar as its siblings).
    expect(within(strip).getAllByText(/no capacity recorded/i)).toHaveLength(3);
    const runwayTile = within(strip).getByText('Runway').closest('div');
    expect(runwayTile).toHaveTextContent('—');
    expect(runwayTile).toHaveTextContent(/unknown — no capacity recorded/i);
    expect(
      within(strip).getByText(/capacity required for procurement timing/i),
    ).toBeInTheDocument();
    expect(within(strip).queryByText(/no projected breach/i)).toBeNull();
    expect(within(strip).queryByText(/\d+\+? mo/i)).toBeNull();

    const banner = screen.getByTestId('recommendation-chip');
    expect(banner).toHaveTextContent(/capacity unknown/i);
    expect(banner).not.toHaveTextContent(/no order needed/i);
    expect(
      screen.getByRole('heading', { name: /forecast — capacity unknown/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /no breach/i })).toBeNull();
  });

  it('renders as a fullscreen takeover: keeps the .cluster-panel class and drops the partial-panel left border/shadow (user decision 2026-07-17)', async () => {
    // The 100vw width lives in the `.cluster-panel` rule (styles.css), not
    // inline — jsdom does not apply that stylesheet, so the fullscreen
    // treatment is asserted via the class plus the removal of the partial-
    // panel-only left border and left drop shadow (a fullscreen takeover has
    // no left edge to separate from the console beneath).
    render(<Harness show />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveClass('cluster-panel');
    expect(dialog).not.toHaveClass('border-l');
    expect(dialog.style.boxShadow).toBe('');
  });

  it('renders the back control as a real link to /, named "Back to clusters", first in DOM order (#243)', async () => {
    // Link semantics, not history.back(): works on deep links and
    // middle-click. The icon is aria-hidden and the sr-only text is the whole
    // accessible name; aria-keyshortcuts states the Esc binding (the visible
    // keycap moved into the tooltip).
    render(<Harness show />);
    await screen.findByText('Prod-East');

    const back = screen.getByRole('link', { name: 'Back to clusters' });
    expect(back).toBe(screen.getByTestId('panel-back-link'));
    expect(back).toHaveAccessibleName('Back to clusters');
    expect(back).toHaveAttribute('href', '/');
    expect(back).toHaveAttribute('aria-keyshortcuts', 'Escape');

    // First in DOM and tab order — before the h1 (WCAG 2.4.3 focus order).
    const heading = screen.getByRole('heading', { level: 1, name: 'Prod-East' });
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('deletes the "Cluster" eyebrow and renders the description as a clamped second line (#243)', async () => {
    render(<Harness show />);
    await screen.findByText('Prod-East');

    // Eyebrow deleted, not demoted: the back control, KPI strip, and context
    // already say "cluster", so the label earned nothing.
    expect(screen.queryByText('Cluster', { exact: true })).toBeNull();
    const description = screen.getByText('Primary production cluster');
    expect(description).toHaveClass('line-clamp-1');
  });

  it('drops the one-off "FORECAST" eyebrow above the forecast heading (#243 Part B item 8)', async () => {
    render(<Harness show />);
    const heading = await screen.findByRole('heading', { name: /no breach in window/i });

    // The eyebrow's DOM text was "Forecast" (an `uppercase` CSS class made it
    // *read* as "FORECAST" — the text node itself is title-case, so this must
    // assert on the actual node text, not the rendered casing). The heading
    // itself always starts with "Forecast — …", never the bare word, so an
    // exact match only ever catches a surviving standalone eyebrow.
    expect(screen.queryByText('Forecast', { exact: true })).toBeNull();
    expect(heading.tagName).toBe('H2');
  });

  // Finding: "Type-scale tokens defined but unused; Settings h1 drops the
  // display font" — the panel title's half. Three sibling top-level
  // headings (verdict, Settings, panel) each carried an arbitrary size
  // instead of the shared --text-h1/--text-display tokens.
  it('adopts the shared text-h1 token for the panel title instead of its own arbitrary size', async () => {
    render(<Harness show />);
    const heading = await screen.findByRole('heading', { level: 1, name: 'Prod-East' });
    expect(heading).toHaveClass('font-display', 'text-h1');
    expect(heading.className).not.toMatch(/text-\[21px\]/);
    expect(heading.className).not.toMatch(/leading-\[1\.1\]/);
    expect(heading.className).not.toMatch(/tracking-\[-0\.01em\]/);
  });

  // Same finding, the "Forecast" section heading's half: it was plain Inter
  // (text-base font-semibold, no font-display) — the section-title
  // inconsistency the audit's "three sibling screens, two typefaces" note
  // named. The docked Scenario pane heading is deliberately NOT touched
  // (spec §5) — it is an 11px mono micro-label by design, not a
  // page-hierarchy section title.
  it('adopts font-display + text-h2 for the Forecast section heading', async () => {
    render(<Harness show />);
    const heading = await screen.findByRole('heading', { name: /no breach in window/i });
    expect(heading).toHaveClass('font-display', 'text-h2');
    expect(heading.className).not.toMatch(/text-base/);
  });

  it('lets the Forecast heading row wrap so WindowControls drops to its own line at narrow widths (#243 Part B item 6)', async () => {
    render(<Harness show />);
    const heading = await screen.findByRole('heading', { name: /no breach in window/i });

    const headingRow = heading.closest('div');
    expect(headingRow).toHaveClass('flex-wrap');
    expect(headingRow).toContainElement(screen.getByRole('group', { name: 'Forecast window' }));
  });

  it('restores focus to the previously-focused element after the panel closes', async () => {
    const { rerender } = render(<Harness show={false} />);
    const trigger = screen.getByRole('button', { name: 'Open trigger' });
    trigger.focus();
    expect(trigger).toHaveFocus();

    rerender(<Harness show />);
    await waitFor(() => expect(screen.getByTestId('panel-back-link')).toHaveFocus());

    rerender(<Harness show={false} />);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('keeps the dialog labeled while the cluster query is still pending (MINOR #5)', () => {
    vi.spyOn(api.clusters, 'get').mockReturnValue(new Promise(() => {})); // never resolves
    render(<Harness show />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Cluster detail');
  });

  it('names the dialog from an attribute on itself, never from inside the content column', async () => {
    // The cluster heading lives in the content column; the dialog names itself
    // via its own `aria-label` attribute rather than pointing `aria-labelledby`
    // at a node inside that column, so the label always resolves. Assert the
    // name and that no `aria-labelledby` source (if one ever existed) sits
    // inside the content column.
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Cluster Prod-East detail');

    const content = screen.getByTestId('panel-content');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    for (const id of labelledBy?.split(/\s+/).filter(Boolean) ?? []) {
      expect(content.contains(document.getElementById(id))).toBe(false);
    }
  });

  it('Esc navigates to / on the same frame — no exit animation, no close delay (#243)', async () => {
    render(<Harness show />);
    await waitFor(() => expect(screen.getByTestId('panel-back-link')).toHaveFocus());

    const dialog = screen.getByRole('dialog');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    // Synchronous, not awaited: the 200ms deferred navigate is gone — closing
    // is pure wait time on a frequent, user-triggered transition (NN/g).
    expect(navigateMock).toHaveBeenCalledWith({ to: '/' });
  });

  it('Escape inside a nested host dialog closes only that dialog, not the panel (CRITICAL #1)', async () => {
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [makeHost()],
      total: 1,
      limit: 500,
      offset: 0,
    });
    const user = userEvent.setup();
    render(<Harness show />);

    await waitFor(() => expect(screen.getByTestId('panel-back-link')).toHaveFocus());
    await screen.findByText('esx-01');

    // Delete now lives behind the row's overflow menu (#243 Part B) — only
    // Edit and Transition stay as top-level icon buttons.
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    const nestedDialog = await screen.findByRole('dialog', { name: /delete esx-01/i });
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    cancelButton.focus();
    expect(cancelButton).toHaveFocus();

    await user.keyboard('{Escape}');

    // The nested dialog is dismissed by its own Escape handling...
    await waitFor(() => expect(nestedDialog).not.toBeInTheDocument());
    // ...but the panel itself must NOT have been asked to close/navigate.
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /prod-east/i })).toBeInTheDocument();
  });

  it('announces "Cluster <name> detail opened." once the cluster loads', async () => {
    render(<Harness show />);
    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Cluster Prod-East detail opened.',
      ),
    );
  });

  it('renders Runway through the shared KpiTile — numeral + caption + status accent, not a Card wrapping RunwayPill (#243 Part B item 2)', async () => {
    render(<Harness show />);
    const strip = await screen.findByTestId('kpi-strip');

    // Default forecast() fixture never crosses the 70% warn threshold across
    // its 3-month window, so runway is "no breach in this horizon" — the
    // numeral carries the horizon length, matching what RunwayPill itself
    // would have shown ("3+ mo"), just as a KpiTile value instead of a badge.
    const runwayLabel = within(strip).getByText('Runway');
    const runwayTile = runwayLabel.closest('div');
    expect(runwayTile).not.toBeNull();
    expect(within(runwayTile!).getByText('3+ mo')).toHaveClass('font-mono');
    expect(runwayTile).toHaveTextContent(/no warn breach in horizon/i);
    // Healthy runway carries no left-accent border, matching every other
    // healthy tile in the strip (Headroom, Order by) — RunwayPill's own
    // amber "accent" Badge doesn't translate 1:1 into the KpiTile grammar,
    // where "ok" reads as the neutral, no-border state.
    expect(runwayTile?.className).not.toMatch(/border-l-2/);
  });

  it('lays the four KPI tiles out 2-up below sm, not four stacked full-width cards (#243 Part B item 3)', async () => {
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    const grid = screen.getByTestId('kpi-grid');
    expect(grid).toHaveClass('grid-cols-2', 'sm:grid-cols-12');
    // Each tile: col-span-1 on the base 2-col grid (half-width, 2-up) instead
    // of the old col-span-12 (full-width, stacked) — sm/lg unchanged. Scoped
    // to the grid itself: "Headroom" also appears in the live-usage section.
    for (const label of ['Current utilization', 'Headroom', 'Runway', 'Order by']) {
      const tile = within(grid).getByText(label).closest('div');
      expect(tile).toHaveClass('col-span-1', 'sm:col-span-6', 'lg:col-span-3');
      expect(tile?.className).not.toMatch(/\bcol-span-12\b/);
    }
  });

  it('renders the KPI strip, recommendation chip, and tabs once data loads', async () => {
    render(<Harness show />);

    expect(await screen.findByTestId('kpi-strip')).toBeInTheDocument();
    expect(screen.getByTestId('recommendation-chip')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Hosts' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /apps/i })).toBeInTheDocument();
    // "Cluster settings", not the bare "Settings" the topbar/⌘K global page
    // also uses (#243 Part B item 5) — the two cross-reference each other by
    // name elsewhere in the app, so the panel's own tab needs its own label.
    expect(screen.getByRole('tab', { name: 'Cluster settings' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
  });

  it('clicking the unknown-capacity recommendation chip switches to and focuses the Hosts tab (#243 Part B item 4)', async () => {
    vi.spyOn(api.clusters, 'get').mockResolvedValue(
      cluster({
        metrics: [
          {
            metricTypeKey: 'memory_gb',
            metricTypeDisplayName: 'Memory',
            unit: 'GB',
            baselineConsumption: 500,
            baselineCapacity: 0,
            currentConsumption: 500,
            currentCapacity: 0,
            utilization: null,
          },
        ],
      }),
    );
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(
      forecast({
        months: [{ month: '2026-07-01', consumption: 500, capacity: 0, utilization: null }],
      }),
    );
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    // Starts on the Hosts tab's sibling by default in this suite (defaultValue
    // 'hosts'), so switch to a different tab first to prove the click below
    // is what moves it back, not the initial default.
    await user.click(screen.getByRole('tab', { name: /apps/i }));
    expect(screen.getByRole('tab', { name: /apps/i })).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByTestId('recommendation-chip-trigger'));

    const hostsTab = screen.getByRole('tab', { name: 'Hosts' });
    await waitFor(() => expect(hostsTab).toHaveAttribute('aria-selected', 'true'));
    await waitFor(() => expect(hostsTab).toHaveFocus());
  });

  it('announces scenario activation and clearing via the live region (IMPORTANT #4)', async () => {
    vi.spyOn(api.clusters, 'forecastScenario').mockResolvedValue(forecast());
    // Docked width keeps the pane open across activate → clear; the pane now
    // stays open on every scenario change (live presets + sliders, #226).
    stubViewportWidth(1280);
    const user = userEvent.setup();
    render(<Harness show />);

    await waitFor(() => expect(screen.getByTestId('panel-back-link')).toHaveFocus());
    await screen.findByTestId('kpi-strip');

    // ScenarioControls lives in the Scenario rail (#226) — open it first.
    await user.click(screen.getByTestId('scenario-button'));

    // Selecting a preset applies its default immediately — there is no Apply
    // step; lose_hosts defaults to count 1.
    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));
    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Scenario active: Lose 1 host.',
      ),
    );

    // Re-tapping the now-active preset returns to the baseline forecast.
    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));
    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Baseline forecast restored.',
      ),
    );
  });
});

describe('<ClusterPanel> scenario pane (#226, docked rail)', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    vi.spyOn(api.clusters, 'get').mockResolvedValue(cluster());
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(forecast());
    vi.spyOn(api.clusters, 'forecastScenario').mockResolvedValue(forecast());
    vi.spyOn(api.clusters, 'liveUsage').mockResolvedValue({ items: [] });
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [],
      total: 0,
      limit: 500,
      offset: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not render ScenarioControls until the rail is opened from the header button', async () => {
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    // The rail is closed on load — no controls, no body.
    expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument();
    expect(screen.queryByTestId('scenario-pane-body')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('scenario-button'));
    expect(await screen.findByTestId('scenario-controls')).toBeInTheDocument();
  });

  it('docks the rail as a fixed-width <aside> beside the content at lg+, leaving the column interactive', async () => {
    stubViewportWidth(1280);
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    const paneBody = await screen.findByTestId('scenario-pane-body');

    // A single instance, docked as an <aside> sibling of the content column —
    // a fixed 340px, border-left column, not inside panel-content.
    const aside = paneBody.closest('aside');
    expect(aside).not.toBeNull();
    expect(aside).toHaveClass('w-[340px]', 'border-l');

    const content = screen.getByTestId('panel-content');
    expect(content).not.toContainElement(paneBody);
    // The content column is never inert now — it stays fully interactive
    // beside the docked rail (no covering sheet, no focus containment).
    expect(content).not.toHaveAttribute('inert');

    // A plain docked body: no glass card, no motion wrapper.
    expect(paneBody.tagName).toBe('DIV');
    expect(paneBody).not.toHaveClass('scenario-card');
  });

  it('stacks the rail inline inside the content column below lg, never covering it', async () => {
    stubViewportWidth(900); // below lg — no room to dock beside the column
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    const content = screen.getByTestId('panel-content');
    expect(content).not.toHaveAttribute('inert');

    await user.click(screen.getByTestId('scenario-button'));
    const paneBody = await screen.findByTestId('scenario-pane-body');

    // Single instance, stacked inline in the content flow — the docked <aside>
    // only exists at lg+, so below lg there is no aside and the body sits
    // inside the (still-interactive) content column.
    expect(paneBody.closest('aside')).toBeNull();
    expect(content).toContainElement(paneBody);
    expect(content).not.toHaveAttribute('inert');
  });

  it('keeps the rail open after selecting a preset so live edits stay reachable (#226)', async () => {
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');
    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));

    // No Apply step and no auto-close: the rail stays open so the sliders keep
    // driving the forecast live (#226 presets + live sliders)…
    expect(screen.getByTestId('scenario-controls')).toBeInTheDocument();
    // …the change is announced…
    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Scenario active: Lose 1 host.',
      ),
    );
    // …and the header indicator marks the active scenario.
    expect(screen.getByTestId('scenario-active-indicator')).toBeInTheDocument();
  });

  it('surfaces an inline error with retry when the scenario forecast fails, and stops claiming an active scenario (#243 Part B item 1)', async () => {
    vi.spyOn(api.clusters, 'forecastScenario').mockRejectedValue(new Error('boom'));
    // lg+ so `panel-content` (with the inline error + Retry) stays visible
    // beside the now-permanently-open rail (#226 — no auto-close on change).
    stubViewportWidth(1280);
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');
    // Selecting a preset sets the scenario, whose forecast fetch rejects.
    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));

    // The correction is announced instead of the (never reached) "Scenario
    // active" text.
    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Scenario could not be computed — showing baseline.',
      ),
    );
    // The header no longer claims an active scenario over what is actually
    // the baseline chart/KPIs.
    expect(screen.queryByTestId('scenario-active-indicator')).not.toBeInTheDocument();
    expect(screen.getByTestId('scenario-button')).toHaveAccessibleName('Scenario');
    // No scenario badge on the KPI strip either — it was already correctly
    // gated on `scenarioQuery.data`, which never arrives here.
    expect(screen.queryByTestId('scenario-badge')).not.toBeInTheDocument();

    // Inline error above the (still baseline) chart, with a retry affordance.
    // Scoped to panel-content (not `screen`): the live region above — a
    // sibling of panel-content, not an ancestor — carries the shorter
    // "…showing baseline." announcement, which also matches this regex.
    const content = screen.getByTestId('panel-content');
    const error = await within(content).findByText(/scenario could not be computed/i);
    const retry = within(content).getByRole('button', { name: 'Retry' });
    expect(error).toBeInTheDocument();

    // Retrying with a now-succeeding mock clears the error and restores the
    // active indicator — proving Retry actually re-fires the query rather
    // than just being decorative.
    vi.spyOn(api.clusters, 'forecastScenario').mockResolvedValue(forecast());
    await user.click(retry);
    await waitFor(() =>
      expect(within(content).queryByText(/scenario could not be computed/i)).toBeNull(),
    );
    expect(screen.getByTestId('scenario-active-indicator')).toBeInTheDocument();
  });

  it('keeps the rail open after clearing the scenario, announcing the baseline restore', async () => {
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    // Activate a preset, then clear it by re-tapping the now-active preset —
    // the rail stays open through both (#226 live editing, no auto-close).
    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');
    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));
    await waitFor(() =>
      expect(screen.getByTestId('scenario-active-indicator')).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));

    // Still open, baseline restore announced, and the active indicator is gone.
    expect(screen.getByTestId('scenario-controls')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Baseline forecast restored.',
      ),
    );
    expect(screen.queryByTestId('scenario-active-indicator')).not.toBeInTheDocument();
  });

  it('keeps the docked rail open after selecting a preset at lg+ — the chart updates live beside it', async () => {
    stubViewportWidth(1280);
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');
    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));

    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Scenario active: Lose 1 host.',
      ),
    );
    expect(screen.getByTestId('scenario-controls')).toBeInTheDocument();
    expect(screen.getByTestId('scenario-summary')).toHaveTextContent('Active: Lose 1 host');
  });

  it('holds the previous scenario forecast on screen while the next slider value fetches', async () => {
    stubViewportWidth(1280);
    // Enough hosts for the "Hosts lost" slider to be enabled and movable.
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(forecast({ hosts: hostsWithCapacity(4) }));
    // The second scenario fetch is held open so the in-flight window is
    // observable rather than a race.
    let releaseSecond: (value: ForecastResponse) => void = () => {};
    const second = new Promise<ForecastResponse>((resolve) => {
      releaseSecond = resolve;
    });
    const scenarioSpy = vi
      .spyOn(api.clusters, 'forecastScenario')
      .mockResolvedValueOnce(forecast())
      .mockReturnValueOnce(second);

    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');
    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));
    // First scenario resolved: the KPI strip says the numbers are hypothetical.
    await screen.findByTestId('scenario-badge');

    // Drag to a new value. Every debounced settle is a NEW query key, so
    // without `placeholderData: keepPreviousData` the scenario data would go
    // undefined here and the whole panel would blink back to the baseline
    // mid-drag — the exact flicker the live redesign exists to avoid.
    fireEvent.change(screen.getByLabelText(/hosts lost/i), { target: { value: '3' } });
    await waitFor(() => expect(scenarioSpy).toHaveBeenCalledTimes(2));

    expect(screen.getByTestId('scenario-badge')).toBeInTheDocument();

    releaseSecond(forecast());
    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Scenario active: Lose 3 hosts.',
      ),
    );
    expect(screen.getByTestId('scenario-badge')).toBeInTheDocument();
  });

  it('drops the held scenario forecast when the next one fails — the chart must match the error', async () => {
    stubViewportWidth(1280);
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(forecast({ hosts: hostsWithCapacity(4) }));
    vi.spyOn(api.clusters, 'forecastScenario')
      .mockResolvedValueOnce(forecast())
      .mockRejectedValueOnce(new Error('boom'));

    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');
    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));
    await screen.findByTestId('scenario-badge');

    fireEvent.change(screen.getByLabelText(/hosts lost/i), { target: { value: '3' } });

    // The inline error says "showing baseline forecast", so the panel must
    // actually fall back to the baseline — NOT keep the previous slider
    // position's what-if on screen under an error that contradicts it.
    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Scenario could not be computed — showing baseline.',
      ),
    );
    expect(screen.queryByTestId('scenario-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('scenario-active-indicator')).not.toBeInTheDocument();
  });

  it('opening the rail moves focus into it; closing returns focus to the Scenario button', async () => {
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    const scenarioButton = screen.getByTestId('scenario-button');
    await user.click(scenarioButton);

    const paneClose = await screen.findByRole('button', { name: 'Close scenario pane' });
    await waitFor(() => expect(paneClose).toHaveFocus());

    await user.click(paneClose);
    await waitFor(() => expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument());
    // Focus returns to the toggle because it held it (focus was inside the
    // rail when it closed).
    await waitFor(() => expect(scenarioButton).toHaveFocus());
  });

  it('Esc closes the rail first (focus back on the button), then a second Esc closes the panel', async () => {
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    const scenarioButton = screen.getByTestId('scenario-button');
    await user.click(scenarioButton);
    await screen.findByTestId('scenario-controls');

    // First Esc: closes the rail only — the panel must NOT navigate.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument());
    expect(navigateMock).not.toHaveBeenCalled();
    await waitFor(() => expect(scenarioButton).toHaveFocus());

    // Second Esc (focus on the header button): now the panel closes.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/' }));
  });

  it('keeps the active scenario clearly indicated on the header button after the rail is closed', async () => {
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');
    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));
    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Scenario active: Lose 1 host.',
      ),
    );

    // The rail no longer auto-closes on change (#226); closing it explicitly
    // must leave the applied scenario in place and visible on the header button.
    await user.click(screen.getByRole('button', { name: 'Close scenario pane' }));
    await waitFor(() => expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument());

    const indicator = screen.getByTestId('scenario-active-indicator');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent('Lose 1 host');
    // Floored at the design system's own --text-label 10px minimum (#243 Part
    // B item 7) — this was the one sub-10px micro text left in this file.
    expect(indicator).toHaveClass('text-[10px]');
    expect(indicator.className).not.toMatch(/text-\[9(\.\d+)?px\]/);
    // A non-colour cue: the summary text is present in the button's accessible name.
    expect(screen.getByTestId('scenario-button')).toHaveAccessibleName(/lose 1 host/i);
    // The colour cue must track the scenario *line*, which is the consumption
    // token (violet) — not the amber accent, which now reads as the warn
    // threshold. Asserted on the class because the token resolves via CSS that
    // jsdom does not apply; this is the only guard on that pairing.
    expect(screen.getByTestId('scenario-button').className).toContain('--chart-consumption');
  });

  it('leaves the header button untinted while no scenario is applied', async () => {
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    // Opening the rail alone must not tint the toggle — only an applied
    // scenario does, so the tint means "the chart is showing a scenario".
    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');

    expect(screen.getByTestId('scenario-button').className).not.toContain('--chart-consumption');
    expect(screen.queryByTestId('scenario-active-indicator')).not.toBeInTheDocument();
  });

  it('exposes disclosure state on the header button and toggles the rail closed on a second click', async () => {
    stubViewportWidth(1280); // docked: the header button stays interactive
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    const scenarioButton = screen.getByTestId('scenario-button');
    expect(scenarioButton).toHaveAttribute('aria-expanded', 'false');
    expect(scenarioButton).not.toHaveAttribute('aria-controls');

    await user.click(scenarioButton);
    await screen.findByTestId('scenario-controls');
    expect(scenarioButton).toHaveAttribute('aria-expanded', 'true');

    // aria-controls must point at the element that actually holds the controls.
    const controlsId = scenarioButton.getAttribute('aria-controls') ?? '';
    expect(controlsId).not.toBe('');
    const pane = document.getElementById(controlsId);
    expect(pane).not.toBeNull();
    expect(pane).toContainElement(screen.getByTestId('scenario-controls'));

    // Third close affordance: the header button itself.
    await user.click(scenarioButton);
    await waitFor(() => expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument());
    expect(scenarioButton).toHaveAttribute('aria-expanded', 'false');
    expect(scenarioButton).not.toHaveAttribute('aria-controls');
    expect(scenarioButton).toHaveFocus();
  });

  it('shows a visible Esc keycap on the pane close control, sourced from ui/kbd.tsx', async () => {
    // Two requirements that pull against each other.
    //
    // 1. The keycap must stay VISIBLE. `aria-keyshortcuts` alone is not an
    //    affordance — no browser renders it — so dropping the keycap would
    //    silently remove the hint sighted pointer users had.
    // 2. It must not be a hand-rolled <kbd>. The control used to carry a
    //    verbatim copy of BackButton's <kbd> class string, which is what made
    //    ui/kbd.tsx's "every keycap comes from here" claim false.
    //
    // `font-mono` is the discriminator for requirement 2: it comes from the
    // Kbd primitive's base recipe, whereas a hand-rolled keycap inside this
    // button inherits the button's own mono face and never sets it. It also
    // survives PR #234, which keeps `border border-border font-mono` as the
    // shared base while moving the box styles into size variants.
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    const paneBody = await screen.findByTestId('scenario-pane-body');

    const keycap = paneBody.querySelector('kbd');
    expect(keycap).not.toBeNull();
    // Two separate negations: multi-arg toHaveClass is an ALL-of check, so a
    // single negated call would only fail when BOTH classes are present.
    expect(keycap).not.toHaveClass('sr-only');
    expect(keycap).not.toHaveClass('hidden');
    expect(keycap).toHaveTextContent('Esc');
    expect(keycap).toHaveClass('font-mono', 'border-border');

    const close = within(paneBody).getByRole('button', { name: 'Close scenario pane' });
    expect(close).toContainElement(keycap);
    expect(close).toHaveAttribute('aria-keyshortcuts', 'Escape');
    // The keycap is decorative: aria-hidden keeps it out of the accessible
    // name, which stays exactly "Close scenario pane" (asserted by the
    // getByRole above) and still contains the visible "Close" — WCAG 2.5.3
    // Label in Name.
    expect(keycap).toHaveAttribute('aria-hidden');
    expect(close).toHaveTextContent('Close');
  });

  it('Esc with the rail open but focus in the content column closes the rail without stealing focus', async () => {
    // Reachable only at lg and up, where the column stays interactive beside
    // the rail. The rail must still swallow the first Esc (the panel stays
    // open), but the user keeps their place in the content.
    stubViewportWidth(1280);
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    const scenarioButton = screen.getByTestId('scenario-button');
    await user.click(scenarioButton);
    await screen.findByTestId('scenario-controls');

    const hostsTab = screen.getByRole('tab', { name: 'Hosts' });
    hostsTab.focus();
    expect(hostsTab).toHaveFocus();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument());
    expect(navigateMock).not.toHaveBeenCalled();
    expect(hostsTab).toHaveFocus();
    expect(scenarioButton).not.toHaveFocus();
  });

  it('re-seeds the form from the applied scenario when the rail is reopened', async () => {
    // Enough tracked hosts that the "Hosts lost" slider (bounded by maxHosts)
    // can reach 3.
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(forecast({ hosts: hostsWithCapacity(4) }));
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');
    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));
    const countInput = await screen.findByLabelText(/hosts lost/i);
    // Sliders drive the scenario live (debounced ~200ms), no Apply step.
    fireEvent.change(countInput, { target: { value: '3' } });
    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Scenario active: Lose 3 hosts.',
      ),
    );

    // The rail no longer auto-closes on change (#226); close it explicitly,
    // then reopen it.
    await user.click(screen.getByRole('button', { name: 'Close scenario pane' }));
    await waitFor(() => expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument());

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');
    // Not the DEFAULT_DRAFT "1": the reopened rail re-seeds from the applied
    // scenario rather than silently resetting to the defaults.
    expect(screen.getByLabelText(/hosts lost/i)).toHaveValue('3');
  });
});

/**
 * Scenario KPI honesty. The strip used to be wired so that "Current
 * utilization" and "Headroom" read the cluster's BASELINE metric while the
 * badge above them claimed every KPI reflected the hypothetical forecast — a
 * scenario that visibly lifted the chart left the two present-tense tiles
 * byte-identical. These pin both halves of the correction: the tiles follow the
 * active forecast's current-month point, and nothing claims a hypothetical the
 * wiring cannot deliver.
 */
describe('<ClusterPanel> scenario KPI honesty', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    vi.spyOn(api.clusters, 'get').mockResolvedValue(cluster());
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(forecast());
    vi.spyOn(api.clusters, 'liveUsage').mockResolvedValue({ items: [] });
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [],
      total: 0,
      limit: 500,
      offset: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Opens the rail and applies a preset. */
  async function applyPreset(
    user: ReturnType<typeof userEvent.setup>,
    kind: 'lose_hosts' | 'add_vms' | 'delay_procurement',
  ): Promise<void> {
    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');
    await user.click(screen.getByTestId(`scenario-preset-${kind}`));
  }

  const grid = (): HTMLElement => screen.getByTestId('kpi-grid');
  const tile = (label: string): HTMLElement => {
    const found = within(grid()).getByText(label).closest('div');
    if (found === null) throw new Error(`no tile for ${label}`);
    return found;
  };

  it('moves Current utilization and Headroom when the scenario moves the present month', async () => {
    // "Add load" starts its synthetic application at `new Date()`, so it lands
    // on the CURRENT month — the one scenario shape that provably moves the
    // present. 500 → 900 GB of a 1,000 GB cluster.
    vi.spyOn(api.clusters, 'forecastScenario').mockResolvedValue(
      forecast({
        months: [monthPoint(0, 900, 1000), monthPoint(1, 950, 1000), monthPoint(2, 1000, 1000)],
      }),
    );
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    // Baseline first: the tiles start on the cluster's real numbers.
    expect(within(grid()).getByText('50.0%')).toBeInTheDocument();
    expect(tile('Headroom')).toHaveTextContent('500 GB');

    await applyPreset(user, 'add_vms');
    await screen.findByTestId('scenario-badge');

    // The whole defect: these two used to stay byte-identical under a scenario
    // that visibly lifted the chart.
    await waitFor(() => expect(within(grid()).getByText('90.0%')).toBeInTheDocument());
    expect(tile('Headroom')).toHaveTextContent('100 GB');
    expect(within(grid()).queryByText('50.0%')).toBeNull();

    // …and only then may the badge claim all of them are hypothetical.
    expect(screen.getByTestId('scenario-badge')).toHaveTextContent(
      /KPIs reflect the hypothetical forecast/i,
    );
    expect(within(grid()).queryByText(/unchanged by this scenario/i)).toBeNull();
  });

  it('never claims a delay_procurement scenario changed the present-tense KPIs', async () => {
    // `delayFutureCommissions` shifts only commissions in the FUTURE, so the
    // present month is unreachable for this preset by construction — a blanket
    // "KPIs reflect the hypothetical forecast" badge is false for it no matter
    // how the tiles are wired.
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(
      forecast({
        months: [monthPoint(0, 500, 1000), monthPoint(1, 550, 1000), monthPoint(2, 600, 1000)],
        procurement: {
          leadTimeWeeks: 6,
          orderByDate: monthFromNow(0),
          breachMonth: monthFromNow(2),
        },
      }),
    );
    vi.spyOn(api.clusters, 'forecastScenario').mockResolvedValue(
      forecast({
        // Identical present month; only the later capacity moves.
        months: [monthPoint(0, 500, 1000), monthPoint(1, 550, 800), monthPoint(2, 600, 800)],
        procurement: {
          leadTimeWeeks: 6,
          orderByDate: monthFromNow(1),
          breachMonth: monthFromNow(2),
        },
      }),
    );
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await applyPreset(user, 'delay_procurement');
    const badge = await screen.findByTestId('scenario-badge');

    // The forward-looking KPIs are genuinely scenario-derived; the present-tense
    // ones are not, and the badge must say exactly that.
    await waitFor(() => expect(badge).toHaveTextContent(/Runway and Order by are hypothetical/i));
    expect(badge).toHaveTextContent(/Current utilization and Headroom are baseline/i);
    expect(badge).not.toHaveTextContent(/KPIs reflect the hypothetical forecast/i);

    // Colour is never the only signal: each present-tense tile says it in text.
    expect(within(grid()).getAllByText(/unchanged by this scenario/i)).toHaveLength(2);
    expect(within(grid()).getByText('50.0%')).toBeInTheDocument();
  });

  it('states outright when an applied scenario resolves to no change at all', async () => {
    // The observed no-op: "Lose 1 host" against hosts with no recorded capacity
    // returns the baseline unchanged, which used to render as an unchanged,
    // healthy forecast under a badge claiming a hypothetical.
    vi.spyOn(api.clusters, 'forecastScenario').mockResolvedValue(forecast());
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await applyPreset(user, 'add_vms');

    const notice = await screen.findByTestId('scenario-noop-notice');
    expect(notice).toHaveTextContent(/does not change the forecast/i);
    expect(screen.getByTestId('scenario-badge')).toHaveTextContent(/changes nothing/i);
    // It must not go on claiming hypothetical KPIs on top of that.
    expect(screen.getByTestId('scenario-badge')).not.toHaveTextContent(
      /KPIs reflect the hypothetical forecast/i,
    );
    // A badge and a notice are both silent to a screen reader; the announcement
    // has to carry it too, without dropping which scenario is applied.
    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Scenario active: Add 20 × 16 GB VMs. It changes nothing in this window.',
      ),
    );
  });

  it('falls back to the stored metric — and says so — when the window has no current month', async () => {
    // A window that opens next month has no honest scenario value for "today".
    const noCurrentMonth = {
      fromMonth: monthFromNow(1),
      toMonth: monthFromNow(3),
      months: [monthPoint(1, 550, 1000), monthPoint(2, 600, 1000), monthPoint(3, 650, 1000)],
    };
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(forecast(noCurrentMonth));
    vi.spyOn(api.clusters, 'forecastScenario').mockResolvedValue(
      forecast({
        ...noCurrentMonth,
        months: [monthPoint(1, 950, 1000), monthPoint(2, 980, 1000), monthPoint(3, 990, 1000)],
      }),
    );
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await applyPreset(user, 'add_vms');
    await screen.findByTestId('scenario-badge');

    // The stored current-month metric (500 of 1,000 GB), never the scenario's
    // nearest month dressed up as "today".
    await waitFor(() =>
      expect(within(grid()).getAllByText(/window does not cover the current month/i)).toHaveLength(
        2,
      ),
    );
    expect(within(grid()).getByText('50.0%')).toBeInTheDocument();
    expect(tile('Headroom')).toHaveTextContent('500 GB');
    expect(screen.getByTestId('scenario-badge')).not.toHaveTextContent(
      /KPIs reflect the hypothetical forecast/i,
    );
  });

  it('keeps the zero-capacity gap under an active scenario — em-dash, reason, and no meter (#200)', async () => {
    vi.spyOn(api.clusters, 'get').mockResolvedValue(
      cluster({
        metrics: [
          {
            metricTypeKey: 'memory_gb',
            metricTypeDisplayName: 'Memory',
            unit: 'GB',
            baselineConsumption: 500,
            baselineCapacity: 0,
            currentConsumption: 500,
            currentCapacity: 0,
            utilization: null,
          },
        ],
      }),
    );
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(
      forecast({ months: [monthPoint(0, 500, 0), monthPoint(1, 550, 0)] }),
    );
    // The scenario moves consumption but capacity stays unknowable: utilization
    // must stay null all the way through, never 0%.
    vi.spyOn(api.clusters, 'forecastScenario').mockResolvedValue(
      forecast({ months: [monthPoint(0, 900, 0), monthPoint(1, 950, 0)] }),
    );
    const user = userEvent.setup();
    render(<Harness show />);
    const strip = await screen.findByTestId('kpi-strip');

    await applyPreset(user, 'add_vms');
    await screen.findByTestId('scenario-badge');

    await waitFor(() => expect(within(grid()).getByText('900 GB used')).toBeInTheDocument());
    expect(strip).not.toHaveTextContent('0.0%');
    const utilization = tile('Current utilization');
    expect(utilization).toHaveTextContent('—');
    expect(utilization).toHaveTextContent(/Unknown — no capacity recorded/i);
    // BulletMeter renders role="img"; a 0-width bar is the "0% used, healthy" lie.
    expect(within(utilization).queryByRole('img')).toBeNull();
    expect(tile('Headroom')).toHaveTextContent(/unknown — no capacity recorded/i);
  });

  it('disables "Lose hosts" with a stated reason when no in-scope host has a known capacity', async () => {
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(
      forecast({
        hosts: [
          { id: 'h1', name: 'esx-01', contributions: [{ month: monthFromNow(0), amount: 0 }] },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');

    const preset = screen.getByTestId('scenario-preset-lose_hosts');
    expect(preset).toBeDisabled();
    expect(preset).toHaveAccessibleDescription(/no host has a recorded capacity/i);
    // Only the inapplicable preset is gated.
    expect(screen.getByTestId('scenario-preset-add_vms')).toBeEnabled();
  });

  it('disables "Lose hosts" when the cluster has no tracked hosts at all', async () => {
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(forecast({ hosts: [] }));
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');

    const preset = screen.getByTestId('scenario-preset-lose_hosts');
    expect(preset).toBeDisabled();
    expect(preset).toHaveAccessibleDescription(/no tracked hosts/i);
  });

  it('leaves "Lose hosts" enabled as soon as one host has a recorded capacity', async () => {
    const user = userEvent.setup();
    render(<Harness show />); // default fixture: one host contributing 1,000 GB
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');

    expect(screen.getByTestId('scenario-preset-lose_hosts')).toBeEnabled();
  });

  it('disables "Delay order" with a stated reason when there is no order-by date to delay', async () => {
    const user = userEvent.setup();
    render(<Harness show />); // default fixture: procurement.orderByDate === null
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');

    const preset = screen.getByTestId('scenario-preset-delay_procurement');
    expect(preset).toBeDisabled();
    expect(preset).toHaveAccessibleDescription(/no order date to delay/i);
  });

  it('enables "Delay order" once the forecast has an order-by date', async () => {
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(
      forecast({
        procurement: {
          leadTimeWeeks: 6,
          orderByDate: monthFromNow(0),
          breachMonth: monthFromNow(2),
        },
      }),
    );
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');

    expect(screen.getByTestId('scenario-preset-delay_procurement')).toBeEnabled();
  });
});

describe('resolvePresentKpi / scenarioChangesNothing / deriveBlockedPresets', () => {
  const metric = cluster().metrics[0]!; // 500 of 1,000 GB, utilization 0.5

  it('agrees with the stored metric when no scenario is active', () => {
    // The premise of the whole fix: `metric` IS the engine's current-month point
    // under baseline inputs, so reading it off the forecast is the same number.
    const base = forecast();
    const present = resolvePresentKpi(base, base, metric, false);
    expect(present).toEqual({
      consumption: metric.currentConsumption,
      capacity: metric.currentCapacity,
      utilization: metric.utilization,
      source: 'forecast',
      hypothetical: false,
    });
  });

  it('marks the value hypothetical when the baseline has no current month to compare against', () => {
    // Unreachable through the UI (both forecasts share a window), and the
    // conservative direction is what matters: an unprovable claim of "unchanged
    // from baseline" is the one thing this must never print.
    const active = forecast();
    const baseline = forecast({ months: [monthPoint(1, 550, 1000)] });
    expect(resolvePresentKpi(active, baseline, metric, true).hypothetical).toBe(true);
  });

  it('falls back to the metric, never to a neighbouring month, when the window skips today', () => {
    const shifted = forecast({ months: [monthPoint(1, 900, 1000), monthPoint(2, 950, 1000)] });
    const present = resolvePresentKpi(shifted, shifted, metric, true);
    expect(present.source).toBe('metric');
    expect(present.consumption).toBe(500);
    expect(present.hypothetical).toBe(false);
  });

  it('detects a scenario that reproduces the baseline exactly', () => {
    expect(scenarioChangesNothing(forecast(), forecast())).toBe(true);
    expect(
      scenarioChangesNothing(
        forecast(),
        forecast({
          months: [monthPoint(0, 501, 1000), monthPoint(1, 550, 1000), monthPoint(2, 600, 1000)],
        }),
      ),
    ).toBe(false);
    // A different horizon is a different forecast, not "no change".
    expect(
      scenarioChangesNothing(forecast(), forecast({ months: [monthPoint(0, 500, 1000)] })),
    ).toBe(false);
  });

  it('blocks nothing while the baseline forecast has not resolved', () => {
    // Gating on absent data would disable presets during every load.
    expect(deriveBlockedPresets(undefined)).toEqual({});
  });

  it('blocks only the presets the data cannot support', () => {
    expect(deriveBlockedPresets(forecast())).toEqual({
      delay_procurement: expect.stringMatching(/no order date to delay/i),
    });
    expect(
      deriveBlockedPresets(
        forecast({
          procurement: {
            leadTimeWeeks: 6,
            orderByDate: monthFromNow(0),
            breachMonth: monthFromNow(2),
          },
        }),
      ),
    ).toEqual({});
  });
});

describe('collectFocusable (Tab-trap candidates)', () => {
  beforeEach(() => {
    // jsdom has no layout: stand in for it, with `data-unrendered` marking the
    // elements a real browser would report no client rects for.
    const rects = [{ width: 10, height: 10 }] as unknown as DOMRectList;
    const noRects = [] as unknown as DOMRectList;
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function getClientRects(
      this: Element,
    ) {
      return this.hasAttribute('data-unrendered') ? noRects : rects;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips elements inside an inert subtree', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <div id="content" inert><button id="covered">Back</button></div>
      <aside><button id="pane-close">Close</button></aside>
    `;
    document.body.appendChild(container);
    try {
      expect(collectFocusable(container).map((el) => el.id)).toEqual(['pane-close']);
    } finally {
      document.body.removeChild(container);
    }
  });

  it('skips elements with no layout box (e.g. an inactive tab panel)', () => {
    const container = document.createElement('div');
    container.innerHTML =
      '<button id="shown">Shown</button><button id="hidden" data-unrendered>Hidden</button>';
    document.body.appendChild(container);
    try {
      expect(collectFocusable(container).map((el) => el.id)).toEqual(['shown']);
    } finally {
      document.body.removeChild(container);
    }
  });
});

describe('isEscapeTargetInsidePanel (CRITICAL #1 guard)', () => {
  it('returns true when the target is the panel container itself', () => {
    const panel = document.createElement('div');
    expect(isEscapeTargetInsidePanel(panel, panel)).toBe(true);
  });

  it('returns true when the target is a descendant of the panel container', () => {
    const panel = document.createElement('div');
    const child = document.createElement('button');
    panel.appendChild(child);
    expect(isEscapeTargetInsidePanel(panel, child)).toBe(true);
  });

  it('returns false when the target sits outside the panel container (e.g. a portaled nested dialog)', () => {
    const panel = document.createElement('div');
    const outside = document.createElement('button');
    document.body.appendChild(panel);
    document.body.appendChild(outside);
    try {
      expect(isEscapeTargetInsidePanel(panel, outside)).toBe(false);
    } finally {
      document.body.removeChild(panel);
      document.body.removeChild(outside);
    }
  });

  it('returns false for a null container or non-Node target', () => {
    expect(isEscapeTargetInsidePanel(null, document.createElement('div'))).toBe(false);
    expect(isEscapeTargetInsidePanel(document.createElement('div'), null)).toBe(false);
  });
});

describe('computeScenarioDeltaLabel (IMPORTANT #2/#3)', () => {
  const THRESHOLDS = { warn: 0.7, crit: 0.9, source: 'tenant' as const };
  const MONTHS = ['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'];

  /** A 4-month series that first breaches warn (0.7) at `breachIndex` (null = never). */
  function monthsSeries(breachIndex: number | null): ForecastResponse['months'] {
    return MONTHS.map((month, i) => {
      const breached = breachIndex !== null && i >= breachIndex;
      return {
        month,
        consumption: breached ? 800 : 500,
        capacity: 1000,
        utilization: breached ? 0.8 : 0.5,
      };
    });
  }

  function series(breachIndex: number | null): ForecastResponse {
    return forecast({ months: monthsSeries(breachIndex), effectiveThresholds: THRESHOLDS });
  }

  it('returns undefined when neither baseline nor scenario ever breaches warn', () => {
    expect(computeScenarioDeltaLabel(series(null), series(null))).toBeUndefined();
  });

  it('returns a ▼ "breach resolved" label when the scenario resolves a baseline breach', () => {
    const label = computeScenarioDeltaLabel(series(1), series(null));
    expect(label).toBe('▼ warn breach resolved (was ≈ Aug 26)');
  });

  it('returns a ▲ "breach introduced" label when the scenario introduces a breach the baseline lacked', () => {
    const label = computeScenarioDeltaLabel(series(null), series(2));
    expect(label).toBe('▲ warn breach introduced ≈ Sep 26');
  });

  it('returns a ▲ "N mo earlier" label when the scenario breaches sooner than the baseline', () => {
    // baseline breaches at index 3 (Oct), scenario at index 1 (Aug) — 2 months earlier.
    const label = computeScenarioDeltaLabel(series(3), series(1));
    expect(label).toBe('▲ warn 2 mo earlier (was ≈ Oct 26)');
  });

  it('returns a ▼ "N mo later" label when the scenario breaches later than the baseline (regression for the ▲/▼ arrow bug)', () => {
    // baseline breaches at index 1 (Aug), scenario at index 3 (Oct) — 2 months later,
    // an improvement, which must render with a ▼ (down/better) arrow, not ▲.
    const label = computeScenarioDeltaLabel(series(1), series(3));
    expect(label).toBe('▼ warn 2 mo later (was ≈ Aug 26)');
  });

  it('returns undefined when baseline and scenario breach at the same month', () => {
    expect(computeScenarioDeltaLabel(series(1), series(1))).toBeUndefined();
  });
});
