import type { ClusterResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { ClusterLifecycleCard } from './cluster-lifecycle-card';

const CLUSTER_ID = 'clu_test_001';

const navigateMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const activeCluster: ClusterResponse = {
  id: CLUSTER_ID,
  name: 'CL-Active',
  description: null,
  baselineDate: '2026-05-01',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  archivedAt: null,
  metrics: [],
};

const archivedCluster: ClusterResponse = {
  ...activeCluster,
  name: 'CL-Archived',
  archivedAt: '2026-05-20T12:00:00Z',
};

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('<ClusterLifecycleCard>', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    vi.spyOn(api.clusters, 'get').mockResolvedValue(activeCluster);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Archive + Delete rows when cluster is active', async () => {
    renderWithClient(<ClusterLifecycleCard clusterId={CLUSTER_ID} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^archive$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    });
  });

  it('renders Unarchive + Delete rows when cluster is archived', async () => {
    vi.spyOn(api.clusters, 'get').mockResolvedValue(archivedCluster);
    renderWithClient(<ClusterLifecycleCard clusterId={CLUSTER_ID} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^unarchive$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    });
  });

  it('archive opens confirm dialog and submits on confirm', async () => {
    const archiveSpy = vi.spyOn(api.clusters, 'archive').mockResolvedValue(archivedCluster);
    renderWithClient(<ClusterLifecycleCard clusterId={CLUSTER_ID} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^archive$/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    expect(screen.getByRole('dialog', { name: /archive cluster/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^archive cluster$/i }));
    await waitFor(() => expect(archiveSpy).toHaveBeenCalledWith(CLUSTER_ID));
  });

  it('archive cancel does not submit', async () => {
    const archiveSpy = vi.spyOn(api.clusters, 'archive').mockResolvedValue(archivedCluster);
    renderWithClient(<ClusterLifecycleCard clusterId={CLUSTER_ID} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^archive$/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it('unarchive opens confirm dialog and submits on confirm', async () => {
    vi.spyOn(api.clusters, 'get').mockResolvedValue(archivedCluster);
    const unarchiveSpy = vi.spyOn(api.clusters, 'unarchive').mockResolvedValue(activeCluster);
    renderWithClient(<ClusterLifecycleCard clusterId={CLUSTER_ID} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^unarchive$/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /^unarchive$/i }));
    expect(screen.getByRole('dialog', { name: /unarchive cluster/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^unarchive cluster$/i }));
    await waitFor(() => expect(unarchiveSpy).toHaveBeenCalledWith(CLUSTER_ID));
  });

  it('delete opens confirm dialog and navigates on confirm', async () => {
    const deleteSpy = vi.spyOn(api.clusters, 'delete').mockResolvedValue(undefined);
    renderWithClient(<ClusterLifecycleCard clusterId={CLUSTER_ID} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(screen.getByRole('dialog', { name: /delete cluster permanently/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /delete forever/i }));
    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith(CLUSTER_ID);
      expect(navigateMock).toHaveBeenCalledWith({ to: '/' });
    });
  });
});
