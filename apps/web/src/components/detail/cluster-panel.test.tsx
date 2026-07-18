import type { ClusterResponse, ForecastResponse, HostResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import {
  ClusterPanel,
  computeScenarioDeltaLabel,
  isEscapeTargetInsidePanel,
} from './cluster-panel';

const CLUSTER_ID = 'cl-1';
const navigateMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
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
      <button type="button">Open trigger</button>
      {show ? <ClusterPanel clusterId={CLUSTER_ID} /> : null}
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
      expect(screen.getByRole('button', { name: /back/i })).toHaveFocus();
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
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

  it('gives the back button an accessible name of exactly "Back", not "Back Esc" (MINOR fix)', async () => {
    // The visible <kbd>Esc</kbd> hint must not concatenate into the
    // accessible name — it's decorative for sighted keyboard users only.
    render(<Harness show />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /back/i })).toHaveFocus();
    });
    expect(screen.getByRole('button', { name: 'Back' })).toHaveAccessibleName('Back');
  });

  it('restores focus to the previously-focused element after the panel closes', async () => {
    const { rerender } = render(<Harness show={false} />);
    const trigger = screen.getByRole('button', { name: 'Open trigger' });
    trigger.focus();
    expect(trigger).toHaveFocus();

    rerender(<Harness show />);
    await waitFor(() => expect(screen.getByRole('button', { name: /back/i })).toHaveFocus());

    rerender(<Harness show={false} />);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('keeps the dialog labeled while the cluster query is still pending (MINOR #5)', () => {
    vi.spyOn(api.clusters, 'get').mockReturnValue(new Promise(() => {})); // never resolves
    render(<Harness show />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Loading cluster…');
  });

  it('Esc navigates to / after the exit transition', async () => {
    render(<Harness show />);
    await waitFor(() => expect(screen.getByRole('button', { name: /back/i })).toHaveFocus());

    const dialog = screen.getByRole('dialog');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/' }));
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

    await waitFor(() => expect(screen.getByRole('button', { name: /back/i })).toHaveFocus());
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

  it('the back button navigates to / and the live region announces the close first', async () => {
    render(<Harness show />);
    await screen.findByText('Prod-East');
    expect(screen.getByRole('status')).toHaveTextContent('Cluster Prod-East detail opened.');

    const user = (await import('@testing-library/user-event')).default.setup();
    await user.click(screen.getByRole('button', { name: /back/i }));

    // The "closed" announcement is set synchronously, before the delayed navigate.
    expect(screen.getByRole('status')).toHaveTextContent('Cluster Prod-East detail closed.');
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/' }));
  });

  it('retains the exit delay under prefers-reduced-motion, so the "closed" announcement has time to be read (MINOR #6)', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })),
    );

    const user = userEvent.setup();
    render(<Harness show />);
    await waitFor(() => expect(screen.getByRole('button', { name: /back/i })).toHaveFocus());

    await user.click(screen.getByRole('button', { name: /back/i }));

    // Reduced motion forbids *animation*, not a deferred navigation: the
    // navigate must NOT fire synchronously with the click...
    expect(navigateMock).not.toHaveBeenCalled();
    // ...but the announcement is already in place, ready to be read...
    expect(screen.getByRole('status')).toHaveTextContent('Cluster Prod-East detail closed.');
    // ...and navigate still follows after the same exit delay.
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/' }));
  });

  it('announces "Cluster <name> detail opened." once the cluster loads', async () => {
    render(<Harness show />);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Cluster Prod-East detail opened.'),
    );
  });

  it('renders the KPI strip, recommendation banner, and tabs once data loads', async () => {
    render(<Harness show />);

    expect(await screen.findByTestId('kpi-strip')).toBeInTheDocument();
    expect(screen.getByTestId('recommendation-banner')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Hosts' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /apps/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
  });

  it('announces scenario activation and clearing via the live region (IMPORTANT #4)', async () => {
    vi.spyOn(api.clusters, 'forecastScenario').mockResolvedValue(forecast());
    const user = userEvent.setup();
    render(<Harness show />);

    await waitFor(() => expect(screen.getByRole('button', { name: /back/i })).toHaveFocus());
    await screen.findByTestId('kpi-strip');

    // ScenarioControls now lives in the slide-in pane (#226) — open it first.
    await user.click(screen.getByTestId('scenario-button'));

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Scenario active: Lose 1 host.'),
    );

    await user.click(screen.getByTestId('scenario-clear'));
    expect(screen.getByRole('status')).toHaveTextContent('Baseline forecast restored.');
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

    const paneClose = await screen.findByRole('button', { name: 'Close scenario panel' });
    await waitFor(() => expect(paneClose).toHaveFocus());

    await user.click(paneClose);
    await waitFor(() => expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument());
    expect(scenarioButton).toHaveFocus();
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
    expect(scenarioButton).toHaveFocus();

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
      expect(screen.getByRole('status')).toHaveTextContent('Scenario active: Lose 1 host.'),
    );

    // Close the pane; the applied scenario must survive and stay visible.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('scenario-controls')).not.toBeInTheDocument());

    const indicator = screen.getByTestId('scenario-active-indicator');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent('Lose 1 host');
    // A non-colour cue: the summary text is present in the button's accessible name.
    expect(screen.getByTestId('scenario-button')).toHaveAccessibleName(/lose 1 host/i);
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
