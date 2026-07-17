import type { ClusterResponse, ForecastResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { ClusterPanel } from './cluster-panel';

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
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [],
      total: 0,
      limit: 500,
      offset: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders as a non-modal dialog and moves focus to the close button on open', async () => {
    render(<Harness show />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /close/i })).toHaveFocus();
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'false');
  });

  it('restores focus to the previously-focused element after the panel closes', async () => {
    const { rerender } = render(<Harness show={false} />);
    const trigger = screen.getByRole('button', { name: 'Open trigger' });
    trigger.focus();
    expect(trigger).toHaveFocus();

    rerender(<Harness show />);
    await waitFor(() => expect(screen.getByRole('button', { name: /close/i })).toHaveFocus());

    rerender(<Harness show={false} />);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('Esc navigates to / after the exit transition', async () => {
    render(<Harness show />);
    await waitFor(() => expect(screen.getByRole('button', { name: /close/i })).toHaveFocus());

    const dialog = screen.getByRole('dialog');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/' }));
  });

  it('the close button navigates to / and the live region announces the close first', async () => {
    render(<Harness show />);
    await screen.findByText('Prod-East');
    expect(screen.getByRole('status')).toHaveTextContent('Cluster Prod-East detail opened.');

    const user = (await import('@testing-library/user-event')).default.setup();
    await user.click(screen.getByRole('button', { name: /close/i }));

    // The "closed" announcement is set synchronously, before the delayed navigate.
    expect(screen.getByRole('status')).toHaveTextContent('Cluster Prod-East detail closed.');
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
});
