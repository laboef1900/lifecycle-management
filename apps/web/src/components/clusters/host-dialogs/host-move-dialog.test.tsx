import type { ClusterResponse, HostResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { HostMoveDialog } from './host-move-dialog';
import { filterMoveDestinations } from './shared';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeHost(overrides: Partial<HostResponse> = {}): HostResponse {
  return {
    id: 'host-1',
    clusterId: 'cl-src',
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
    capacities: [],
    ...overrides,
  };
}

function makeCluster(overrides: Partial<ClusterResponse> = {}): ClusterResponse {
  return {
    id: 'cl-src',
    name: 'Source cluster',
    description: null,
    baselineDate: '2025-01-01',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    archivedAt: null,
    metrics: [],
    ...overrides,
  };
}

function renderDialog(
  host: HostResponse,
  onOpenChange: (open: boolean) => void = vi.fn(),
): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HostMoveDialog open onOpenChange={onOpenChange} clusterId={host.clusterId} host={host} />
    </QueryClientProvider>,
  );
}

// `filterMoveDestinations` backs the <Select>'s option list. Radix's Select
// popover mounts its own focus-trapping Content nested inside the Dialog's
// FocusScope; opening it via userEvent in this jsdom setup recurses to a stack
// overflow (a pre-existing environment limitation — no test anywhere in this
// suite opens a Select popover while a Dialog is mounted; the fleet console's
// Select is exercised the same way but stands alone, never inside a Dialog).
// Testing the pure filter directly covers the same exclusion logic without
// depending on that interaction.
describe('filterMoveDestinations', () => {
  it('excludes the current cluster and any synced (source: vsphere) cluster', () => {
    const clusters = [
      makeCluster({ id: 'cl-src', name: 'Source cluster' }),
      makeCluster({ id: 'cl-dst', name: 'Destination cluster' }),
      makeCluster({ id: 'cl-synced', name: 'Synced cluster', source: 'vsphere' }),
    ];

    const result = filterMoveDestinations(clusters, 'cl-src');

    expect(result.map((c) => c.id)).toEqual(['cl-dst']);
  });

  it('treats an absent source as eligible (predates sync metadata, not a security decision)', () => {
    // `source` intentionally omitted — a server build that predates sync
    // metadata (exactOptionalPropertyTypes forbids `source: undefined`).
    const clusters = [makeCluster({ id: 'cl-other', name: 'Other cluster' })];

    expect(filterMoveDestinations(clusters, 'cl-src').map((c) => c.id)).toEqual(['cl-other']);
  });
});

describe('<HostMoveDialog>', () => {
  beforeEach(() => {
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [
        makeCluster({ id: 'cl-src', name: 'Source cluster' }),
        makeCluster({ id: 'cl-dst', name: 'Destination cluster' }),
        makeCluster({ id: 'cl-synced', name: 'Synced cluster', source: 'vsphere' }),
      ],
      total: 3,
      limit: 500,
      offset: 0,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requires an explicit confirmation step before calling the move endpoint', async () => {
    const moveSpy = vi
      .spyOn(api.hosts, 'move')
      .mockResolvedValue(makeHost({ clusterId: 'cl-dst' }));
    const user = userEvent.setup();
    renderDialog(makeHost());

    await screen.findByRole('combobox', { name: /destination cluster/i });
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // The first submit only reveals the confirmation step — no API call yet.
    expect(moveSpy).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: /confirm move/i })).toBeInTheDocument();
    // The scope/consequence of the action is spelled out in the confirmation copy.
    expect(screen.getByText(/esx-01/)).toBeInTheDocument();
    expect(screen.getAllByText(/Destination cluster/).length).toBeGreaterThan(0);
  });

  it('lets the operator step back from the confirmation screen without submitting', async () => {
    const moveSpy = vi
      .spyOn(api.hosts, 'move')
      .mockResolvedValue(makeHost({ clusterId: 'cl-dst' }));
    const user = userEvent.setup();
    renderDialog(makeHost());

    await screen.findByRole('combobox', { name: /destination cluster/i });
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByRole('heading', { name: /confirm move/i });

    await user.click(screen.getByRole('button', { name: /back/i }));

    expect(screen.getByRole('combobox', { name: /destination cluster/i })).toBeInTheDocument();
    expect(moveSpy).not.toHaveBeenCalled();
  });

  it('calls the move endpoint with the (auto-selected) destination and a first-of-month date only after confirming', async () => {
    const onOpenChange = vi.fn();
    const moveSpy = vi
      .spyOn(api.hosts, 'move')
      .mockResolvedValue(makeHost({ clusterId: 'cl-dst' }));
    const user = userEvent.setup();
    renderDialog(makeHost(), onOpenChange);

    // Only one eligible destination (cl-dst) remains after filtering, so it is
    // already selected by default — no need to open the Select popover.
    await screen.findByRole('combobox', { name: /destination cluster/i });

    const monthInput = screen.getByLabelText(/effective month/i);
    await user.clear(monthInput);
    await user.type(monthInput, '2026-09');

    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByRole('heading', { name: /confirm move/i });

    await user.click(screen.getByRole('button', { name: /move host/i }));

    expect(moveSpy).toHaveBeenCalledWith('host-1', { clusterId: 'cl-dst', moveDate: '2026-09-01' });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('surfaces a server rejection and returns to the form for correction', async () => {
    const { ApiError } = await import('@/lib/api-client');
    vi.spyOn(api.hosts, 'move').mockRejectedValue(
      new ApiError(422, {
        error: { code: 'INVALID_MOVE_DATE', message: 'moveDate must be after the current start' },
      }),
    );
    const user = userEvent.setup();
    renderDialog(makeHost());

    await screen.findByRole('combobox', { name: /destination cluster/i });
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByRole('heading', { name: /confirm move/i });
    await user.click(screen.getByRole('button', { name: /move host/i }));

    await screen.findByRole('combobox', { name: /destination cluster/i });
    expect(toast.error).toHaveBeenCalled();
  });

  it('hides the destination select and shows an explanatory message when no eligible cluster exists', async () => {
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [makeCluster({ id: 'cl-src', name: 'Source cluster' })],
      total: 1,
      limit: 500,
      offset: 0,
    });
    renderDialog(makeHost());

    expect(
      await screen.findByText(/no other cluster is available as a move destination/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: /destination cluster/i }),
    ).not.toBeInTheDocument();
  });
});
