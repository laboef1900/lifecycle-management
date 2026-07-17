import type { HostResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { HostsTab } from './hosts-tab';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeHost(overrides: Partial<HostResponse> = {}): HostResponse {
  return {
    id: 'host-1',
    clusterId: 'cl-1',
    name: 'esx-01',
    description: null,
    commissionedAt: '2025-06-01',
    decommissionedAt: null,
    serialNumber: null,
    vendor: null,
    model: null,
    purchasedAt: null,
    warrantyEndsAt: null,
    eolAt: null,
    runPastEol: false,
    state: 'in_service',
    projectedDecommissionAt: null,
    createdAt: '2025-06-01T00:00:00.000Z',
    updatedAt: '2025-06-01T00:00:00.000Z',
    capacities: [
      {
        id: 'cap-1',
        metricTypeKey: 'memory_gb',
        metricTypeDisplayName: 'Memory',
        unit: 'GB',
        effectiveFrom: '2025-06-01',
        amount: 1024,
      },
    ],
    ...overrides,
  };
}

function renderTab(canManage = true): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HostsTab clusterId="cl-1" canManage={canManage} />
    </QueryClientProvider>,
  );
}

describe('HostsTab', () => {
  beforeEach(() => {
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [makeHost(), makeHost({ id: 'host-2', name: 'esx-02' })],
      total: 2,
      limit: 500,
      offset: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a row per host', async () => {
    renderTab();

    expect(await screen.findByText('esx-01')).toBeInTheDocument();
    expect(screen.getByText('esx-02')).toBeInTheDocument();
  });

  it('shows the Add host button for managers and hides it for viewers', async () => {
    renderTab(true);
    expect(await screen.findByRole('button', { name: /add host/i })).toBeInTheDocument();

    cleanup();
    renderTab(false);
    await screen.findByText('esx-01');
    expect(screen.queryByRole('button', { name: /add host/i })).not.toBeInTheDocument();
  });

  it('shows a truncation note when the server total exceeds the fetched rows', async () => {
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [makeHost(), makeHost({ id: 'host-2', name: 'esx-02' })],
      total: 512,
      limit: 500,
      offset: 0,
    });
    renderTab();

    expect(await screen.findByText('esx-01')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Showing first 2 of 512 hosts.');
  });

  it('omits the truncation note when all hosts fit in one page', async () => {
    renderTab();

    expect(await screen.findByText('esx-01')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders the empty state (not a host row) when the cluster has no hosts', async () => {
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [],
      total: 0,
      limit: 500,
      offset: 0,
    });
    renderTab();

    expect(
      await screen.findByText('Add a host to start contributing capacity.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No hosts yet.')).toBeInTheDocument();
    expect(screen.queryByText('esx-01')).not.toBeInTheDocument();
  });

  it('shows skeleton placeholders while the hosts query is pending', () => {
    // A never-resolving fetch keeps the query in its pending state.
    vi.spyOn(api.hosts, 'listByCluster').mockReturnValue(new Promise<never>(() => {}));
    const { container } = renderTab();

    expect(container.querySelector('.animate-shimmer')).toBeInTheDocument();
    expect(
      screen.queryByText('Add a host to start contributing capacity.'),
    ).not.toBeInTheDocument();
  });

  it('replaces the date columns with one Lifecycle gantt cell per host, aria-labelled with all three dates', async () => {
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [
        makeHost({
          commissionedAt: '2024-03-15',
          warrantyEndsAt: '2027-03-15',
          eolAt: '2029-03-15',
        }),
        makeHost({ id: 'host-2', name: 'esx-02' }),
      ],
      total: 2,
      limit: 500,
      offset: 0,
    });
    renderTab();

    expect(await screen.findByText('esx-01')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Lifecycle' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Commissioned' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Decommissioned' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Warranty' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'EOL' })).not.toBeInTheDocument();

    const rows = screen.getAllByRole('img');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAccessibleName(
      'esx-01: commissioned 2024-03-15, warranty until 2027-03-15, hardware EOL 2029-03-15.',
    );
  });

  it('shows the full lifecycle dates in the expanded row content', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [
        makeHost({
          commissionedAt: '2024-03-15',
          warrantyEndsAt: '2027-03-15',
          eolAt: '2029-03-15',
        }),
      ],
      total: 1,
      limit: 500,
      offset: 0,
    });
    renderTab();

    expect(await screen.findByText('esx-01')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand history' }));

    expect(screen.getByText('Lifecycle dates')).toBeInTheDocument();
    expect(screen.getAllByText(/2024-03-15/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2027-03-15/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2029-03-15/).length).toBeGreaterThan(0);
  });
});
