import type { ClusterResponse, ForecastResponse, HostResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { api } from '@/lib/api-client';

import {
  ClusterPanel,
  PANE_CLOSED,
  collectFocusable,
  computeScenarioDeltaLabel,
  isEscapeTargetInsidePanel,
  paneIsOnScreen,
  panePresenceReducer,
  scenarioPaneLayout,
} from './cluster-panel';

const CLUSTER_ID = 'cl-1';

/**
 * The panel reads two viewport breakpoints (`640px` for the compact chart,
 * `1024px` for pane side-by-side vs. overlay). The shared setup stub answers
 * `false` to every query, i.e. the narrowest viewport — good for the overlay
 * cases, useless for the side-by-side ones, so tests that care state a width.
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

/**
 * Like `stubViewportWidth`, but the returned setter also notifies the `change`
 * listeners `useMediaQuery` subscribes with — the only way to exercise a
 * breakpoint crossing (rotate / resize / split view) on a mounted panel.
 */
function stubResizableViewport(initialWidth: number): (width: number) => void {
  let width = initialWidth;
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => {
      const minWidth = /min-width:\s*(\d+)px/.exec(query)?.[1];
      return {
        // A getter, not a snapshot: `useSyncExternalStore` re-reads
        // `matchMedia(query).matches` after every notification.
        get matches(): boolean {
          return minWidth === undefined ? false : width >= Number(minWidth);
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
        removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
        dispatchEvent: () => false,
      };
    }),
  );
  return (next: number) => {
    width = next;
    act(() => {
      for (const notify of listeners) notify();
    });
  };
}

/** jsdom has no layout, so `getClientRects()` is empty for every element and
 *  the panel's Tab trap short-circuits. Give every element a box so the trap
 *  actually runs. */
function stubLayoutBoxes(): void {
  const rects = [{ width: 10, height: 10 }] as unknown as DOMRectList;
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue(rects);
}
/**
 * Records any attempt to move focus into the content column while that column
 * is inert.
 *
 * `focusin` fires synchronously from `.focus()`, so this is a pure ordering
 * check with no dependency on how long the exit animation happens to take —
 * unlike sampling the DOM on a timer or on mutations, which races the
 * animation and flakes on a loaded runner.
 */
function watchFocusIntoInert(): { violations: string[]; stop: () => void } {
  const violations: string[] = [];
  const onFocusIn = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('[inert]') !== null) {
      violations.push(
        `focus moved into the inert column: ${target.dataset.testid ?? target.tagName}`,
      );
    }
  };
  document.addEventListener('focusin', onFocusIn);
  return { violations, stop: () => document.removeEventListener('focusin', onFocusIn) };
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

function forecast(overrides: Partial<ForecastResponse> = {}): ForecastResponse {
  return {
    fromMonth: '2026-07-01',
    toMonth: '2026-09-01',
    months: [
      { month: '2026-07-01', consumption: 500, capacity: 1000, utilization: 0.5 },
      { month: '2026-08-01', consumption: 550, capacity: 1000, utilization: 0.55 },
      { month: '2026-09-01', consumption: 600, capacity: 1000, utilization: 0.6 },
    ],
    events: [],
    hosts: [],
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

/**
 * `Harness` deliberately omits LazyMotion, so `m.*` renders as plain DOM and
 * AnimatePresence removes an exiting child immediately — which is why every
 * other test here sees closing as instantaneous. This harness mirrors app.tsx
 * instead, so the pane's 200ms exit actually occupies wall-clock time and the
 * window between "closing" and "gone" can be asserted.
 */
function AnimatedHarness(): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <LazyMotion features={domAnimation} strict>
          <MotionConfig reducedMotion="user">
            <ClusterPanel clusterId={CLUSTER_ID} />
          </MotionConfig>
        </LazyMotion>
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
      forecast({
        months: [
          { month: '2026-07-01', consumption: 500, capacity: 0, utilization: null },
          { month: '2026-08-01', consumption: 550, capacity: 0, utilization: null },
        ],
      }),
    );

    render(<Harness show />);
    const strip = await screen.findByTestId('kpi-strip');
    // The 0%-lie must never render on the purchasing-decision KPI strip.
    expect(strip).not.toHaveTextContent('0.0%');
    // A text-carried "unknown" reason, not color alone.
    expect(within(strip).getAllByText(/no capacity recorded/i)).toHaveLength(2);
    expect(within(strip).getByText(/^unknown — no capacity$/i)).toBeInTheDocument();
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

  it('names the dialog from an attribute on itself, never from inside the coverable content column', async () => {
    // The cluster heading lives in the content column, which goes `inert` while
    // the Scenario sheet covers it below `lg` — and inert subtrees are removed
    // from the accessibility tree. jsdom's accname implementation ignores
    // `inert` entirely, so asserting the *name* alone would pass either way;
    // what has to hold is that the name's source is not in that subtree.
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

    await user.click(screen.getByRole('button', { name: 'Delete' }));
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

  it('renders the KPI strip, recommendation chip, and tabs once data loads', async () => {
    render(<Harness show />);

    expect(await screen.findByTestId('kpi-strip')).toBeInTheDocument();
    expect(screen.getByTestId('recommendation-chip')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Hosts' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /apps/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
  });

  it('announces scenario activation and clearing via the live region (IMPORTANT #4)', async () => {
    vi.spyOn(api.clusters, 'forecastScenario').mockResolvedValue(forecast());
    const user = userEvent.setup();
    render(<Harness show />);

    await waitFor(() => expect(screen.getByTestId('panel-back-link')).toHaveFocus());
    await screen.findByTestId('kpi-strip');

    // ScenarioControls now lives in the slide-in pane (#226) — open it first.
    await user.click(screen.getByTestId('scenario-button'));

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Scenario active: Lose 1 host.',
      ),
    );

    await user.click(screen.getByTestId('scenario-clear'));
    expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
      'Baseline forecast restored.',
    );
  });
});

describe('<ClusterPanel> scenario pane (#226)', () => {
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

  it('does not render ScenarioControls inline; it lives in the pane opened from the header button', async () => {
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    // Inline controls are gone until the pane is opened.
    expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('scenario-button'));
    expect(await screen.findByTestId('scenario-controls')).toBeInTheDocument();
  });

  it('opening the pane moves focus into it; closing returns focus to the Scenario button', async () => {
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    const scenarioButton = screen.getByTestId('scenario-button');
    await user.click(scenarioButton);

    const paneClose = await screen.findByRole('button', { name: 'Close scenario pane' });
    await waitFor(() => expect(paneClose).toHaveFocus());

    await user.click(paneClose);
    await waitFor(() => expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument());
    // `waitFor`, not a bare assertion: the restore now waits for the exit to
    // finish (see the containment test) rather than firing on the click.
    await waitFor(() => expect(scenarioButton).toHaveFocus());
  });

  it('Esc closes the pane first (focus back on the button), then a second Esc closes the panel', async () => {
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    const scenarioButton = screen.getByTestId('scenario-button');
    await user.click(scenarioButton);
    await screen.findByTestId('scenario-controls');

    // First Esc: closes the pane only — the panel must NOT navigate.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument());
    expect(navigateMock).not.toHaveBeenCalled();
    await waitFor(() => expect(scenarioButton).toHaveFocus());

    // Second Esc (focus on the in-panel button): now the panel closes.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/' }));
  });

  it('keeps the active scenario clearly indicated on the header button after the pane is closed', async () => {
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Scenario active: Lose 1 host.',
      ),
    );

    // Close the pane; the applied scenario must survive and stay visible.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument());

    const indicator = screen.getByTestId('scenario-active-indicator');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent('Lose 1 host');
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

    // Opening the pane alone must not tint the toggle — only an applied
    // scenario does, so the tint means "the chart is showing a scenario".
    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');

    expect(screen.getByTestId('scenario-button').className).not.toContain('--chart-consumption');
    expect(screen.queryByTestId('scenario-active-indicator')).not.toBeInTheDocument();
  });

  it('exposes disclosure state on the header button and toggles the pane closed on a second click', async () => {
    stubViewportWidth(1280); // side-by-side: the header button stays interactive
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

  it('becomes a full-panel modal sheet below lg, so the inert column is genuinely covered (WCAG 2.4.11)', async () => {
    stubViewportWidth(900); // below lg
    stubLayoutBoxes();
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    const content = screen.getByTestId('panel-content');
    expect(content).not.toHaveAttribute('inert');

    await user.click(screen.getByTestId('scenario-button'));
    const paneClose = await screen.findByRole('button', { name: 'Close scenario pane' });
    await waitFor(() => expect(paneClose).toHaveFocus());

    // The pane still spans the whole panel below lg — since #243 as a
    // scrim-tinted aside with the controls on a floating glass card, rather
    // than an opaque full-height sheet body. A 340px strip over a 100vw panel
    // would leave ~560px of this column reachable by pointer while inert —
    // a worse defect than the focus-obscured bug the inert is here to fix.
    // jsdom applies no stylesheets and does not run the width animation to a
    // deterministic point, so the material/geometry are asserted structurally
    // here; the real bounding-box + hit-test proof lives in
    // playwright/scenario-pane.spec.ts.
    const paneBody = screen.getByTestId('scenario-pane-body');
    expect(paneBody).toHaveClass('scenario-card');
    const paneAside = paneBody.closest('aside');
    expect(paneAside).not.toBeNull();
    expect(paneAside).toHaveClass('max-lg:bg-black/40');

    // Only because the sheet layer takes every pointer hit is `inert` on the
    // whole column honest — including the back link and Scenario button it
    // covers.
    expect(content).toHaveAttribute('inert');
    const backLink = screen.getByTestId('panel-back-link');
    expect(content).toContainElement(backLink);

    // ...and the panel's own Tab trap agrees: Shift+Tab off the pane's first
    // control wraps to the pane's last control, never onto a covered one.
    await user.tab({ shift: true });
    expect(backLink).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveFocus();

    // Closing the pane hands the column back.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(content).not.toHaveAttribute('inert'));
  });

  it('stays a 340px sibling at lg and up, covering nothing and leaving the column interactive', async () => {
    stubViewportWidth(1280);
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');
    // The 340px reserved gutter (the aside) still compresses the column; the
    // card floats inside it at 348px — 16px right inset + 24px overlap under
    // the column's 24px right padding (#243). Class-level assertions: jsdom
    // computes no Tailwind; the pixel geometry is Playwright's job.
    expect(screen.getByTestId('scenario-pane-body')).toHaveClass('scenario-card', 'lg:w-[348px]');
    expect(screen.getByTestId('panel-content')).not.toHaveAttribute('inert');
  });

  it('shows a visible Esc keycap on the pane close control, sourced from ui/kbd.tsx', async () => {
    // Two requirements that pull against each other.
    //
    // 1. The keycap must stay VISIBLE. `aria-keyshortcuts` alone is not an
    //    affordance — no browser renders it — so dropping the keycap would
    //    silently remove the hint sighted pointer users had, and would leave
    //    this control inconsistent with the BackButton a few elements away in
    //    the panel header, which shows the same kind of hint.
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
    // NOT `toBeVisible()`: the glass card fades in (#243) and motion never
    // advances past the initial `opacity: 0` keyframe under jsdom, so
    // jest-dom would report the card's subtree invisible forever. The
    // real-browser visibility half of this requirement is asserted in
    // playwright/scenario-pane.spec.ts ("the close control shows a visible
    // Esc keycap"); this test owns the structural half.
    expect(keycap).not.toHaveClass('sr-only', 'hidden');
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

  it('holds the containment until the closing sheet has finished painting over the column', async () => {
    // The sheet keeps covering the column for AnimatePresence's 200ms exit.
    // Releasing `inert` the instant `paneOpen` flips false would re-create the
    // focus-obscured condition for that window — and would also try to restore
    // focus into a subtree that is still inert, where `focus()` is a no-op.
    stubViewportWidth(900);
    const user = userEvent.setup();
    render(<AnimatedHarness />);
    await screen.findByTestId('kpi-strip');

    const scenarioButton = screen.getByTestId('scenario-button');
    const content = screen.getByTestId('panel-content');
    await user.click(scenarioButton);
    await screen.findByTestId('scenario-controls');
    expect(content).toHaveAttribute('inert');
    const paneClose = screen.getByRole('button', { name: 'Close scenario pane' });
    expect(paneClose).toHaveFocus();

    const closing = watchFocusIntoInert();

    // Synchronous dispatch, with nothing awaited before the assertions below:
    // an animation frame can only run once the stack unwinds, so what is
    // observed is exactly the commit `closePane` produced. (`user.keyboard`
    // awaits internally, which on a loaded runner can let the whole 200ms exit
    // finish first — a race with the animation, not a behaviour difference.)
    fireEvent.keyDown(paneClose, { key: 'Escape' });

    // Still mounted, so still painted over the column...
    expect(screen.getByTestId('scenario-controls')).toBeInTheDocument();
    expect(content).toHaveAttribute('inert');
    // ...and therefore focus has not been handed back into it yet.
    expect(scenarioButton).not.toHaveFocus();

    await waitFor(() => expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument());
    closing.stop();

    // Focus was never pushed into the column while it was still inert — where
    // `focus()` is a no-op in a real browser and would strand focus on <body>.
    expect(closing.violations).toEqual([]);
    expect(content).not.toHaveAttribute('inert');
    await waitFor(() => expect(scenarioButton).toHaveFocus());
  });

  it('re-homes focus into the pane when a resize turns the content column inert', async () => {
    // Focus in the content column with the pane open is reachable at lg and up
    // (that is what the Esc-without-focus-steal behaviour supports). Crossing
    // below lg then turns that column inert underneath the focused element: a
    // real browser blurs it and focus falls to <body>, from where Tab never
    // reaches the panel's React `onKeyDown` trap — focus escapes the modal
    // entirely unless the pane reclaims it. jsdom does not implement inert, so
    // here `document.activeElement` stays on the tab trigger instead; the code
    // treats both as lost focus.
    const resizeTo = stubResizableViewport(1280);
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');

    const hostsTab = screen.getByRole('tab', { name: 'Hosts' });
    hostsTab.focus();
    expect(hostsTab).toHaveFocus();

    resizeTo(900);

    const content = screen.getByTestId('panel-content');
    expect(content).toHaveAttribute('inert');
    expect(content).toContainElement(hostsTab);
    expect(hostsTab).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close scenario pane' })).toHaveFocus();
  });

  it('leaves focus alone when a resize hands the content column back', async () => {
    // The mirror case: growing past lg un-inerts the column, which loses
    // nothing — the re-home must not fire and steal the user's place.
    const resizeTo = stubResizableViewport(900);
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    const countInput = await screen.findByLabelText(/hosts to drop/i);
    countInput.focus();

    resizeTo(1280);

    expect(screen.getByTestId('panel-content')).not.toHaveAttribute('inert');
    expect(countInput).toHaveFocus();
  });

  it('Esc with the pane open but focus in the content column closes the pane without stealing focus', async () => {
    // Reachable only at lg and up, where the column stays interactive beside
    // the pane. The pane must still swallow the first Esc (the panel stays
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

  it('re-seeds the form from the applied scenario when the pane is reopened', async () => {
    const user = userEvent.setup();
    render(<Harness show />);
    await screen.findByTestId('kpi-strip');

    await user.click(screen.getByTestId('scenario-button'));
    const countInput = await screen.findByLabelText(/hosts to drop/i);
    await user.clear(countInput);
    await user.type(countInput, '3');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(screen.getByTestId('panel-live-region')).toHaveTextContent(
        'Scenario active: Lose 3 hosts.',
      ),
    );

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument());

    await user.click(screen.getByTestId('scenario-button'));
    await screen.findByTestId('scenario-controls');
    // Not the DEFAULT_DRAFT "1": a stray Apply must not silently replace the
    // applied scenario with the defaults.
    expect(screen.getByLabelText(/hosts to drop/i)).toHaveValue(3);
  });

  it('recovers cleanly when the pane is reopened mid-exit and closed again', async () => {
    // Guards the AnimatePresence exit-window race: a same-key child that
    // re-enters mid-exit is recycled, not remounted, so focus must be driven by
    // the open state rather than by the pane body's mount.
    //
    // MUST run under `AnimatedHarness`. Under `Harness` (no LazyMotion)
    // AnimatePresence drops an exiting child synchronously, so there is no exit
    // window at all and the reopen below would be an ordinary closed->open
    // cycle that exercises nothing. The `toBe(bodyBeforeClose)` identity
    // assertion is what proves the child was recycled rather than remounted —
    // i.e. that the race was really entered.
    //
    // Runs at lg+ because that is the only width where a mid-exit reopen is
    // reachable: below lg the Scenario button is inert until the exit finishes.
    //
    // The `exiting`-flag half of this race is guarded separately and directly by
    // the `panePresenceReducer` suite below — it is a pure state transition with
    // no observable rendering consequence while `open` is true, so no
    // integration test here can pin it. Kept honest deliberately.
    stubViewportWidth(1280);
    render(<AnimatedHarness />);
    await screen.findByTestId('kpi-strip');

    const scenarioButton = screen.getByTestId('scenario-button');
    fireEvent.click(scenarioButton);
    const bodyBeforeClose = await screen.findByTestId('scenario-pane-body');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Close scenario pane' })).toHaveFocus(),
    );

    // Synchronous dispatch with nothing awaited in between: an animation frame
    // can only run once the stack unwinds, so the reopen lands inside the exit
    // window. (`userEvent` awaits internally and would let the 200ms exit
    // finish first on a loaded runner.)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close scenario pane' }), {
      key: 'Escape',
    });
    // Mid-exit: still mounted, still painting over the column.
    expect(screen.getByTestId('scenario-pane-body')).toBe(bodyBeforeClose);
    // A real pointer click focuses the button it hits; `fireEvent.click` does
    // not, so do it explicitly. Without this, focus would never leave the pane
    // close control and the "focus came back" assertion below would hold
    // vacuously — including for a mount-driven implementation.
    scenarioButton.focus();
    expect(scenarioButton).toHaveFocus();
    fireEvent.click(scenarioButton);

    // Recycled, not remounted — the same DOM node came back, which is exactly
    // why a mount-driven focus effect would silently skip moving focus here.
    expect(screen.getByTestId('scenario-pane-body')).toBe(bodyBeforeClose);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Close scenario pane' })).toHaveFocus(),
    );

    // And the recycled pane still closes cleanly, restoring focus to the
    // trigger once the (real, uncancelled) exit has finished.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close scenario pane' }), {
      key: 'Escape',
    });
    await waitFor(() => expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument());
    await waitFor(() => expect(scenarioButton).toHaveFocus());
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('applies the containment as soon as the pane opens, not after the enter animation', async () => {
    // Pins the deliberate enter/exit asymmetry documented at the `inert` site.
    // The exit side holds the containment until `onExitComplete`; the enter side
    // applies it on the opening commit, accepting a <=280ms window in which part
    // of the column is visible but inert. Deferring it to match the exit side
    // would instead leave the column *interactive* while the sheet covers it —
    // the WCAG 2.4.11 condition the containment exists to prevent.
    stubViewportWidth(900);
    render(<AnimatedHarness />);
    await screen.findByTestId('kpi-strip');

    const content = screen.getByTestId('panel-content');
    expect(content).not.toHaveAttribute('inert');

    fireEvent.click(screen.getByTestId('scenario-button'));

    // Asserted before anything is awaited, so the 280ms enter animation cannot
    // have progressed, let alone completed.
    expect(content).toHaveAttribute('inert');
  });
});

describe('panePresenceReducer (AnimatePresence exit-window state)', () => {
  it('marks the pane on screen while it is open', () => {
    const open = panePresenceReducer(PANE_CLOSED, 'open');
    expect(open).toEqual({ open: true, exiting: false });
    expect(paneIsOnScreen(open)).toBe(true);
  });

  it('keeps the pane on screen after close until the exit completes', () => {
    // This is what holds the content column's `inert` across the 200ms exit:
    // dropping it the instant `open` flips false would hand the column back
    // while the sheet is still painted over it.
    const exiting = panePresenceReducer(panePresenceReducer(PANE_CLOSED, 'open'), 'close');
    expect(exiting).toEqual({ open: false, exiting: true });
    expect(paneIsOnScreen(exiting)).toBe(true);

    const gone = panePresenceReducer(exiting, 'exit-complete');
    expect(gone).toEqual(PANE_CLOSED);
    expect(paneIsOnScreen(gone)).toBe(false);
  });

  it('clears the exiting flag when the pane re-enters mid-exit', () => {
    // The invariant no integration test can observe: a mid-exit re-entry
    // cancels the exit, and a cancelled exit never fires `onExitComplete`
    // (AnimatePresence drops the key from its `exitComplete` map), so `open` is
    // the only place the flag can be cleared. While the pane is open a stale
    // flag is masked by `open` in `paneIsOnScreen` — it shows up only as
    // `exiting` no longer meaning "exiting", and as the next close inheriting a
    // state it did not produce.
    const exiting = panePresenceReducer(panePresenceReducer(PANE_CLOSED, 'open'), 'close');
    expect(exiting.exiting).toBe(true);

    const reopened = panePresenceReducer(exiting, 'open');
    expect(reopened).toEqual({ open: true, exiting: false });
  });

  it('leaves a fully closed pane closed when a stray exit-complete arrives', () => {
    expect(panePresenceReducer(PANE_CLOSED, 'exit-complete')).toEqual(PANE_CLOSED);
  });
});

describe('scenarioPaneLayout (pane geometry ↔ content containment)', () => {
  it('is a fixed strip that covers nothing when it can sit beside the column', () => {
    expect(scenarioPaneLayout(true)).toEqual({ width: 340, coversContent: false });
  });

  it('spans the whole panel when it has to overlay the column', () => {
    expect(scenarioPaneLayout(false)).toEqual({ width: '100vw', coversContent: true });
  });

  it('never claims to cover the column at a width narrower than the panel', () => {
    // The invariant the function exists to hold: `coversContent` is what
    // licenses `inert` on the content column, so it may only be true when the
    // pane really spans the panel. Decoupling them is how the column ended up
    // visible-but-inert at 640–1023px.
    for (const sideBySide of [true, false]) {
      const layout = scenarioPaneLayout(sideBySide);
      expect(layout.coversContent).toBe(layout.width === '100vw');
    }
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

  it('skips elements inside an inert subtree (the pane-covered content column)', () => {
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
