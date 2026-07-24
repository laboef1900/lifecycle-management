import type {
  ClusterResponse,
  ForecastEntityContribution,
  ForecastResponse,
  ProcurementInfo,
  TenantSettings,
} from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { FleetConsole, sortClusters, sortClustersByUrgency } from './fleet-console';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    hash,
    ...rest
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
    hash?: string;
  }) => {
    let href = to;
    for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, v);
    if (hash) href = `${href}#${hash}`;
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

// The empty-state Add-cluster CTA is `AdminOnly`-gated. Default to viewer so the
// existing render tests stay unaffected; the admin tests flip it and `afterEach`
// puts it back — `restoreAllMocks` alone does not reset a hoisted `vi.fn`, so
// without an explicit reset this default holds only by test ordering.
const { useIsAdminMock } = vi.hoisted(() => ({ useIsAdminMock: vi.fn(() => false) }));
vi.mock('@/lib/auth', () => ({ useIsAdmin: () => useIsAdminMock() }));

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

function cluster(id: string, name: string): ClusterResponse {
  return {
    id,
    name,
    description: null,
    baselineDate: '2026-06-01',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archivedAt: null,
    metrics: [],
  };
}

function procurement(orderByDate: string | null): ProcurementInfo {
  return { leadTimeWeeks: 13, orderByDate, breachMonth: orderByDate ? '2027-01-01' : null };
}

function memoryMetric(capacity: number): ClusterResponse['metrics'][number] {
  return {
    metricTypeKey: 'memory_gb',
    metricTypeDisplayName: 'Memory',
    unit: 'GB',
    baselineConsumption: 0,
    baselineCapacity: capacity,
    currentConsumption: 0,
    currentCapacity: capacity,
    utilization: 0,
  };
}

function sizedCluster(id: string, name: string, capacity: number): ClusterResponse {
  return { ...cluster(id, name), metrics: [memoryMetric(capacity)] };
}

describe('sortClustersByUrgency', () => {
  it('orders by ascending order-by date, with null order-bys last', () => {
    const entries = [
      {
        cluster: cluster('p2', 'CL-Prod-P2'),
        procurement: procurement('2026-10-03'),
        runwayMonths: 6,
      },
      {
        cluster: cluster('none', 'CL-Dev'),
        procurement: procurement(null),
        runwayMonths: null,
      },
      {
        cluster: cluster('oracle', 'CL-Prod-P2-Oracle'),
        procurement: procurement('2026-09-14'),
        runwayMonths: 5,
      },
    ];
    const sorted = sortClustersByUrgency(entries);
    expect(sorted.map((e) => e.cluster.id)).toEqual(['oracle', 'p2', 'none']);
  });

  it('breaks ties on the same order-by date using runway months', () => {
    const entries = [
      { cluster: cluster('a', 'A'), procurement: procurement('2026-09-14'), runwayMonths: 8 },
      { cluster: cluster('b', 'B'), procurement: procurement('2026-09-14'), runwayMonths: 3 },
    ];
    const sorted = sortClustersByUrgency(entries);
    expect(sorted.map((e) => e.cluster.id)).toEqual(['b', 'a']);
  });

  it('breaks ties among null order-bys using runway months', () => {
    const entries = [
      { cluster: cluster('a', 'A'), procurement: undefined, runwayMonths: 24 },
      { cluster: cluster('b', 'B'), procurement: undefined, runwayMonths: 12 },
    ];
    const sorted = sortClustersByUrgency(entries);
    expect(sorted.map((e) => e.cluster.id)).toEqual(['b', 'a']);
  });

  it('does not mutate the input array', () => {
    const entries = [
      { cluster: cluster('a', 'A'), procurement: procurement('2026-12-01'), runwayMonths: 1 },
      { cluster: cluster('b', 'B'), procurement: procurement('2026-09-01'), runwayMonths: 1 },
    ];
    const original = [...entries];
    sortClustersByUrgency(entries);
    expect(entries).toEqual(original);
  });
});

describe('sortClusters', () => {
  it('orderBy delegates to urgency ordering (earliest order-by first)', () => {
    const entries = [
      { cluster: cluster('a', 'A'), procurement: procurement('2026-12-01'), runwayMonths: 1 },
      { cluster: cluster('b', 'B'), procurement: procurement('2026-09-01'), runwayMonths: 1 },
    ];
    expect(sortClusters(entries, 'orderBy').map((e) => e.cluster.id)).toEqual(['b', 'a']);
  });

  it('name sorts alphabetically by cluster name, ignoring order-by and size', () => {
    const entries = [
      {
        cluster: sizedCluster('c', 'CL-Charlie', 99000),
        procurement: procurement('2026-09-01'),
        runwayMonths: 1,
      },
      {
        cluster: sizedCluster('a', 'CL-Alpha', 1000),
        procurement: procurement('2026-12-01'),
        runwayMonths: 9,
      },
      { cluster: sizedCluster('b', 'CL-Bravo', 50000), procurement: undefined, runwayMonths: null },
    ];
    expect(sortClusters(entries, 'name').map((e) => e.cluster.id)).toEqual(['a', 'b', 'c']);
  });

  it('size sorts by total memory capacity, largest first', () => {
    const entries = [
      {
        cluster: sizedCluster('small', 'CL-Small', 5000),
        procurement: undefined,
        runwayMonths: null,
      },
      { cluster: sizedCluster('big', 'CL-Big', 30000), procurement: undefined, runwayMonths: null },
      { cluster: sizedCluster('mid', 'CL-Mid', 15000), procurement: undefined, runwayMonths: null },
    ];
    expect(sortClusters(entries, 'size').map((e) => e.cluster.id)).toEqual(['big', 'mid', 'small']);
  });

  it('size sums every metric and breaks capacity ties by name', () => {
    const multi: ClusterResponse = {
      ...cluster('multi', 'CL-Multi'),
      metrics: [memoryMetric(6000), memoryMetric(4000)],
    };
    // Same 10 000 total as `multi`, but an earlier name → wins the tie.
    const single = sizedCluster('single', 'CL-Aaa', 10000);
    const entries = [
      { cluster: multi, procurement: undefined, runwayMonths: null },
      { cluster: single, procurement: undefined, runwayMonths: null },
    ];
    expect(sortClusters(entries, 'size').map((e) => e.cluster.id)).toEqual(['single', 'multi']);
  });

  it('does not mutate the input array', () => {
    const entries = [
      { cluster: sizedCluster('a', 'A', 100), procurement: undefined, runwayMonths: null },
      { cluster: sizedCluster('b', 'B', 200), procurement: undefined, runwayMonths: null },
    ];
    const original = [...entries];
    sortClusters(entries, 'size');
    expect(entries).toEqual(original);
  });
});

function makeCluster(overrides: Partial<ClusterResponse> = {}): ClusterResponse {
  return {
    id: 'c1',
    name: 'CL-A',
    description: null,
    baselineDate: '2026-06-01',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archivedAt: null,
    metrics: [
      {
        metricTypeKey: 'memory_gb',
        metricTypeDisplayName: 'Memory',
        unit: 'GB',
        baselineConsumption: 4000,
        baselineCapacity: 10000,
        currentConsumption: 4000,
        currentCapacity: 10000,
        utilization: 0.4,
      },
    ],
    ...overrides,
  };
}

function makeTenantSettings(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return {
    warnThreshold: 0.7,
    critThreshold: 0.9,
    procurementLeadTimeWeeks: 13,
    idempotencyKeyRetentionHours: 24,
    forecastUncertaintyBandEnabled: false,
    forecastUncertaintyMinAnchors: 6,
    forecastUncertaintyBandWidth: 'p10_p90',
    ...overrides,
  };
}

function makeForecast(overrides: Partial<ForecastResponse> = {}): ForecastResponse {
  return {
    baselineHistory: [],
    fromMonth: '2026-07-01',
    toMonth: '2028-06-01',
    months: [
      { month: '2026-07-01', consumption: 4000, capacity: 10000, utilization: 0.4 },
      { month: '2026-08-01', consumption: 4100, capacity: 10000, utilization: 0.41 },
    ],
    events: [],
    hosts: [],
    applications: [],
    effectiveThresholds: { warn: 0.7, crit: 0.9, source: 'system' },
    procurement: { leadTimeWeeks: 13, orderByDate: null, breachMonth: null },
    ...overrides,
  };
}

function makeHost(id: string, name: string): ForecastEntityContribution {
  return { id, name, projectedDecommissionAt: null, contributions: [] };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderConsole(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FleetConsole />
    </QueryClientProvider>,
  );
}

describe('<FleetConsole> (render)', () => {
  beforeEach(() => {
    // Default: no synced clusters. Individual tests override as needed. Keeps
    // the batch live-usage query off the real network (#193).
    vi.spyOn(api.clusters, 'liveUsage').mockResolvedValue({ items: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // `restoreAllMocks` only restores `vi.spyOn` spies; reset the hoisted role
    // mock and re-state the file default so the suite is order-independent.
    useIsAdminMock.mockReset();
    useIsAdminMock.mockReturnValue(false);
  });

  it('shows the cluster count alone while forecasts are loading, then "N CLUSTERS · M HOSTS" once resolved (finding 2)', async () => {
    const c1 = makeCluster({ id: 'c1', name: 'CL-A' });
    // No metric configured -> immediately errors, contributing 0 hosts.
    const c2 = makeCluster({ id: 'c2', name: 'CL-B', metrics: [] });
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [c1, c2],
      total: 2,
      limit: 100,
      offset: 0,
    });
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue(makeTenantSettings());
    const forecastC1 = deferred<ForecastResponse>();
    vi.spyOn(api.clusters, 'forecast').mockImplementation((id) =>
      id === 'c1' ? forecastC1.promise : Promise.reject(new Error('unexpected forecast call')),
    );

    renderConsole();

    // c2 (no metric configured) errors out immediately and renders its tile
    // without waiting on any forecast; c1's forecast is still pending ->
    // hostCount is null -> the "Clusters" instrument shows the plain count,
    // no "HOSTS", while its tile is still a loading skeleton.
    expect(await screen.findByText('CL-B')).toBeInTheDocument();
    expect(screen.queryByText('CL-A')).toBeNull();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText(/HOSTS/)).toBeNull();

    forecastC1.resolve(
      makeForecast({
        hosts: [makeHost('h1', 'esx-1'), makeHost('h2', 'esx-2'), makeHost('h3', 'esx-3')],
      }),
    );

    expect(await screen.findByText('2 CLUSTERS · 3 HOSTS')).toBeInTheDocument();
  });

  it('renders an archived cluster tile with an em dash instead of a synthetic "0+" (finding 3)', async () => {
    const active = makeCluster({ id: 'c1', name: 'CL-Active' });
    const archived = makeCluster({
      id: 'c9',
      name: 'CL-Retired',
      archivedAt: '2026-01-01T00:00:00Z',
    });
    vi.spyOn(api.clusters, 'list').mockImplementation((params) =>
      Promise.resolve({
        items: params?.includeArchived ? [active, archived] : [active],
        total: params?.includeArchived ? 2 : 1,
        limit: 100,
        offset: 0,
      }),
    );
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue(makeTenantSettings());
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(makeForecast());

    const user = userEvent.setup();
    renderConsole();

    expect(await screen.findByText('CL-Active')).toBeInTheDocument();
    // #243: the archived toggle lives in the Filter popover on the toolbar.
    await user.click(screen.getByTestId('fleet-filter-button'));
    await user.click(await screen.findByRole('checkbox', { name: /show archived/i }));

    expect(await screen.findByText('CL-Retired')).toBeInTheDocument();
    const archivedTile = screen.getByText('CL-Retired').closest('a[data-cluster-id]');
    expect(archivedTile).not.toBeNull();
    const scoped = within(archivedTile as HTMLElement);
    expect(scoped.getByText('—')).toBeInTheDocument();
    expect(archivedTile).not.toHaveTextContent('0+');
  });

  it('Filter popover carries the live archived count, an active-count badge, and announces the mixed view (#243)', async () => {
    const active = makeCluster({ id: 'c1', name: 'CL-Active' });
    const archived = makeCluster({
      id: 'c9',
      name: 'CL-Retired',
      archivedAt: '2026-01-01T00:00:00Z',
    });
    vi.spyOn(api.clusters, 'list').mockImplementation((params) =>
      Promise.resolve({
        items: params?.includeArchived ? [active, archived] : [active],
        total: params?.includeArchived ? 2 : 1,
        limit: 100,
        offset: 0,
      }),
    );
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue(makeTenantSettings());
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(makeForecast());

    const user = userEvent.setup();
    renderConsole();
    expect(await screen.findByText('CL-Active')).toBeInTheDocument();

    // Nothing is announced for the default state on load.
    expect(screen.getByTestId('fleet-filter-announcement')).toHaveTextContent('');

    const trigger = screen.getByTestId('fleet-filter-button');
    // Radix exposes the disclosure state on the trigger.
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Default view → no active-count badge, no active tone.
    expect(screen.queryByTestId('fleet-filter-count')).toBeNull();

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    // Opening the popover enables the archived query, so the checkbox item
    // carries the real count — before the toggle is ever switched on.
    const checkbox = await screen.findByRole('checkbox', { name: /show archived \(1\)/i });
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);
    expect(checkbox).toBeChecked();

    // The mixed view stays explainable from the toolbar without reopening
    // the popover: active tone + `· 1` count on the trigger…
    expect(await screen.findByTestId('fleet-filter-count')).toHaveTextContent('· 1');
    // …and the change is announced in words with the resulting totals.
    await waitFor(() =>
      expect(screen.getByTestId('fleet-filter-announcement')).toHaveTextContent(
        'Showing 2 clusters including 1 archived.',
      ),
    );

    await user.click(checkbox);
    await waitFor(() =>
      expect(screen.getByTestId('fleet-filter-announcement')).toHaveTextContent(
        'Showing 1 cluster.',
      ),
    );
    expect(screen.queryByTestId('fleet-filter-count')).toBeNull();
  });
});

describe('<FleetConsole> Clusters pane + sort (#267)', () => {
  beforeEach(() => {
    vi.spyOn(api.clusters, 'liveUsage').mockResolvedValue({ items: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useIsAdminMock.mockReset();
    useIsAdminMock.mockReturnValue(false);
  });

  it('groups tiles in a titled "Clusters" pane and re-sorts when the sort changes', async () => {
    const clusters = [
      makeCluster({ id: 'a', name: 'CL-Alpha', metrics: [memoryMetric(30000)] }),
      makeCluster({ id: 'b', name: 'CL-Bravo', metrics: [memoryMetric(5000)] }),
      makeCluster({ id: 'c', name: 'CL-Charlie', metrics: [memoryMetric(15000)] }),
    ];
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: clusters,
      total: 3,
      limit: 100,
      offset: 0,
    });
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue(makeTenantSettings());
    // Distinct order-by dates so urgency, name, and size each yield a different
    // order — a sort that silently no-ops would fail at least one assertion.
    const orderByDates: Record<string, string> = {
      a: '2026-12-01',
      b: '2026-09-01',
      c: '2026-10-01',
    };
    vi.spyOn(api.clusters, 'forecast').mockImplementation((id) =>
      Promise.resolve(
        makeForecast({
          procurement: {
            leadTimeWeeks: 13,
            orderByDate: orderByDates[id] ?? null,
            breachMonth: '2027-06-01',
          },
        }),
      ),
    );

    const user = userEvent.setup();
    const { container } = renderConsole();

    // Tiles are grouped under a titled "Clusters" pane heading.
    expect(await screen.findByRole('heading', { level: 2, name: 'Clusters' })).toBeInTheDocument();

    const tileOrder = () =>
      Array.from(container.querySelectorAll('a[data-cluster-id]')).map((el) =>
        el.getAttribute('data-cluster-id'),
      );

    // Default: procurement urgency — earliest order-by date first.
    await waitFor(() => expect(tileOrder()).toEqual(['b', 'c', 'a']));

    // Sort by Name → alphabetical.
    await user.click(screen.getByTestId('fleet-sort-trigger'));
    await user.click(await screen.findByRole('option', { name: 'Name' }));
    await waitFor(() => expect(tileOrder()).toEqual(['a', 'b', 'c']));

    // Sort by Size → largest total memory capacity first.
    await user.click(screen.getByTestId('fleet-sort-trigger'));
    await user.click(await screen.findByRole('option', { name: 'Size' }));
    await waitFor(() => expect(tileOrder()).toEqual(['a', 'c', 'b']));
  });

  it('exposes the sort control with an accessible name and all three options', async () => {
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [makeCluster({ id: 'a', name: 'CL-A' })],
      total: 1,
      limit: 100,
      offset: 0,
    });
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue(makeTenantSettings());
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(makeForecast());

    const user = userEvent.setup();
    renderConsole();

    const trigger = await screen.findByRole('combobox', { name: 'Sort clusters' });
    // Default value is shown on the trigger.
    expect(trigger).toHaveTextContent('Order-by date');

    await user.click(trigger);
    expect(await screen.findByRole('option', { name: 'Order-by date' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Size' })).toBeInTheDocument();
  });
});

describe('<FleetConsole> heading (every render branch has an h1)', () => {
  beforeEach(() => {
    vi.spyOn(api.clusters, 'liveUsage').mockResolvedValue({ items: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // `restoreAllMocks` only restores `vi.spyOn` spies; reset the hoisted role
    // mock and re-state the file default so the suite is order-independent.
    useIsAdminMock.mockReset();
    useIsAdminMock.mockReturnValue(false);
  });

  it('renders a level-1 heading while clusters are still loading', () => {
    // Never resolves within the test — clustersQuery stays isPending, so the
    // console renders only the skeleton branch.
    vi.spyOn(api.clusters, 'list').mockReturnValue(new Promise(() => {}));
    vi.spyOn(api.settings.tenant, 'get').mockReturnValue(new Promise(() => {}));

    renderConsole();

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders a level-1 heading in the error state', async () => {
    vi.spyOn(api.clusters, 'list').mockRejectedValue(new Error('boom'));
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue(makeTenantSettings());

    renderConsole();

    expect(await screen.findByText(/Could not load clusters/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders a level-1 heading in the empty state (no clusters)', async () => {
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue(makeTenantSettings());

    renderConsole();

    // Wait for the empty-state content specifically before asserting the
    // heading — both the loading and empty branches render an identical
    // sr-only h1, so asserting the heading alone could pass while still on
    // the (also headed) loading branch.
    expect(await screen.findByText('No clusters yet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('shows the admin an Add-cluster CTA in the empty state linking to Settings', async () => {
    useIsAdminMock.mockReturnValue(true);
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue(makeTenantSettings());

    renderConsole();

    const link = await screen.findByRole('link', { name: /add a cluster in settings/i });
    // The hash is load-bearing: /settings/inventory alone lands above the
    // fold with the Add-cluster panel second down the Inventory sub-route and
    // focus left on <body>. #293 moved this panel off the single flat
    // `/settings` page onto its own Inventory sub-route.
    expect(link).toHaveAttribute('href', '/settings/inventory#add-cluster');
  });

  it('hides the empty-state CTA link from viewers but still tells them what to do', async () => {
    useIsAdminMock.mockReturnValue(false);
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue(makeTenantSettings());

    renderConsole();

    expect(await screen.findByText('No clusters yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /add a cluster in settings/i })).toBeNull();
    // Without this, deleting the fallback would leave viewers staring at an
    // empty console with no explanation — and pass every other assertion.
    expect(screen.getByText(/ask an administrator to add a cluster in settings/i)).toBeVisible();
  });
});

describe('<FleetConsole> Add-cluster affordance lives in Settings only (#223)', () => {
  beforeEach(() => {
    vi.spyOn(api.clusters, 'liveUsage').mockResolvedValue({ items: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useIsAdminMock.mockReset();
    useIsAdminMock.mockReturnValue(false);
  });

  it('shows admins no Add-cluster control in the populated console toolbar', async () => {
    // Admin + a non-empty cluster list is the exact state the removed toolbar
    // trigger used to render in; every other test runs as viewer or empty, so
    // reinstating the trigger would otherwise pass the whole suite.
    useIsAdminMock.mockReturnValue(true);
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [makeCluster({ id: 'c1', name: 'CL-A' })],
      total: 1,
      limit: 100,
      offset: 0,
    });
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue(makeTenantSettings());
    vi.spyOn(api.clusters, 'forecast').mockResolvedValue(makeForecast());

    renderConsole();

    // The toolbar only exists on the populated branch — wait for it (#243:
    // the console control is now the Filter popover trigger).
    expect(await screen.findByTestId('fleet-filter-button')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add cluster/i })).toBeNull();
    expect(screen.queryByText('+ Add cluster')).toBeNull();
    expect(screen.queryByRole('link', { name: /add a cluster in settings/i })).toBeNull();
  });
});
