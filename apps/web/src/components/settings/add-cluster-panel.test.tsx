import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { AddClusterPanel } from './add-cluster-panel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The panel is `AdminOnly`-gated via `useIsAdmin`, which reads router context.
// Mock the hook so the panel renders in isolation and each test controls the
// role. Default admin; the VIEWER test flips it.
const { useIsAdminMock } = vi.hoisted(() => ({ useIsAdminMock: vi.fn(() => true) }));
vi.mock('@/lib/auth', () => ({ useIsAdmin: () => useIsAdminMock() }));

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('<AddClusterPanel>', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useIsAdminMock.mockReturnValue(true);
  });

  it('renders the section heading and Add cluster trigger for admins', () => {
    renderWithClient(<AddClusterPanel />);
    expect(screen.getByRole('heading', { name: 'Add cluster' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add cluster' })).toBeInTheDocument();
  });

  it('renders nothing for viewers', () => {
    useIsAdminMock.mockReturnValue(false);
    const { container } = renderWithClient(<AddClusterPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the create-cluster dialog and creates a cluster end-to-end', async () => {
    vi.spyOn(api.clusters, 'create').mockResolvedValue({} as never);
    const user = userEvent.setup();
    renderWithClient(<AddClusterPanel />);

    await user.click(screen.getByRole('button', { name: '+ Add cluster' }));
    const dialog = screen.getByRole('dialog', { name: 'New cluster' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'CL-Settings-1');
    await user.clear(within(dialog).getByRole('spinbutton', { name: 'Consumption (GB)' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Consumption (GB)' }), '100');
    await user.clear(within(dialog).getByRole('spinbutton', { name: 'Capacity (GB)' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Capacity (GB)' }), '500');
    await user.click(within(dialog).getByRole('button', { name: 'Create cluster' }));

    await waitFor(() => {
      expect(api.clusters.create).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(api.clusters.create).mock.calls[0]?.[0]).toMatchObject({
      name: 'CL-Settings-1',
      baselines: [{ metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 500 }],
    });
  });
});
