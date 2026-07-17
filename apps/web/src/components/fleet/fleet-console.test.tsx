import type {
  ClusterResponse,
  ForecastEntityContribution,
  ForecastResponse,
  ProcurementInfo,
  TenantSettings,
} from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { FleetConsole, sortClustersByUrgency } from './fleet-console';

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

vi.mock('@/lib/auth', () => ({
  // Skips CreateClusterDialog (AdminOnly renders nothing for non-admins),
  // which otherwise pulls in its own mutation/toast wiring irrelevant here.
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
  return { warnThreshold: 0.7, critThreshold: 0.9, procurementLeadTimeWeeks: 13, ...overrides };
}

function makeForecast(overrides: Partial<ForecastResponse> = {}): ForecastResponse {
  return {
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
  afterEach(() => {
    vi.restoreAllMocks();
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
    await user.click(screen.getByRole('button', { name: /show archived/i }));

    expect(await screen.findByText('CL-Retired')).toBeInTheDocument();
    const archivedTile = screen.getByText('CL-Retired').closest('a[data-cluster-id]');
    expect(archivedTile).not.toBeNull();
    const scoped = within(archivedTile as HTMLElement);
    expect(scoped.getByText('—')).toBeInTheDocument();
    expect(archivedTile).not.toHaveTextContent('0+');
  });
});

describe('<FleetConsole> heading (every render branch has an h1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
    expect(await screen.findByText('No clusters yet.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});
