import type { ClusterResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { ClusterIdentityForm } from './cluster-identity-form';

const CLUSTER_ID = 'clu_test_001';

const baseCluster: ClusterResponse = {
  id: CLUSTER_ID,
  name: 'CL-Original',
  description: 'Original description',
  baselineDate: '2026-05-01',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  metrics: [
    {
      metricTypeKey: 'memory_gb',
      metricTypeDisplayName: 'Memory',
      unit: 'GB',
      baselineConsumption: 400,
      baselineCapacity: 1000,
      currentConsumption: 400,
      currentCapacity: 1000,
      utilization: 0.4,
    },
  ],
};

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('<ClusterIdentityForm>', () => {
  beforeEach(() => {
    vi.spyOn(api.clusters, 'get').mockResolvedValue(baseCluster);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and displays current name + description', async () => {
    renderWithClient(<ClusterIdentityForm clusterId={CLUSTER_ID} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toHaveValue('CL-Original');
      expect(screen.getByLabelText(/description/i)).toHaveValue('Original description');
    });
  });

  it('disables Save until a field changes', async () => {
    renderWithClient(<ClusterIdentityForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toHaveValue('CL-Original'));
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/name/i));
    await userEvent.type(screen.getByLabelText(/name/i), 'CL-Renamed');
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled();
  });

  it('submits only the changed name field', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue({
      ...baseCluster,
      name: 'CL-Renamed',
    });
    renderWithClient(<ClusterIdentityForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toHaveValue('CL-Original'));
    await userEvent.clear(screen.getByLabelText(/name/i));
    await userEvent.type(screen.getByLabelText(/name/i), 'CL-Renamed');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(CLUSTER_ID, { name: 'CL-Renamed' });
    });
  });

  it('submits description=null when description is cleared', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue({
      ...baseCluster,
      description: null,
    });
    renderWithClient(<ClusterIdentityForm clusterId={CLUSTER_ID} />);
    await waitFor(() =>
      expect(screen.getByLabelText(/description/i)).toHaveValue('Original description'),
    );
    await userEvent.clear(screen.getByLabelText(/description/i));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(CLUSTER_ID, { description: null });
    });
  });

  it('shows an inline error when name is empty on submit', async () => {
    renderWithClient(<ClusterIdentityForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toHaveValue('CL-Original'));
    await userEvent.clear(screen.getByLabelText(/name/i));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText(/name is required/i)).toBeInTheDocument();
  });
});
