import type { ClusterResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { BaselineEditForm } from './baseline-edit-form';

const CLUSTER_ID = 'clu_test_001';

const baseCluster: ClusterResponse = {
  id: CLUSTER_ID,
  name: 'CL-Test',
  description: null,
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

describe('<BaselineEditForm>', () => {
  beforeEach(() => {
    vi.spyOn(api.clusters, 'get').mockResolvedValue(baseCluster);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and displays current baseline date + per-metric values', async () => {
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/baseline date/i)).toHaveValue('2026-05-01');
      expect(screen.getByLabelText(/memory.*consumption/i)).toHaveValue(400);
      expect(screen.getByLabelText(/memory.*capacity/i)).toHaveValue(1000);
    });
  });

  it('disables Save until a field changes', async () => {
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/baseline date/i)).toHaveValue('2026-05-01'));
    expect(screen.getByRole('button', { name: /save baseline/i })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/memory.*consumption/i));
    await userEvent.type(screen.getByLabelText(/memory.*consumption/i), '500');
    expect(screen.getByRole('button', { name: /save baseline/i })).toBeEnabled();
  });

  it('opens a confirm dialog on save instead of submitting immediately', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/memory.*consumption/i)).toHaveValue(400));
    await userEvent.clear(screen.getByLabelText(/memory.*consumption/i));
    await userEvent.type(screen.getByLabelText(/memory.*consumption/i), '500');
    await userEvent.click(screen.getByRole('button', { name: /save baseline/i }));
    expect(screen.getByRole('dialog', { name: /rewrite baseline/i })).toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('cancel button in the dialog does not submit', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/memory.*consumption/i)).toHaveValue(400));
    await userEvent.clear(screen.getByLabelText(/memory.*consumption/i));
    await userEvent.type(screen.getByLabelText(/memory.*consumption/i), '500');
    await userEvent.click(screen.getByRole('button', { name: /save baseline/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('confirm submits the full baselines array even when only one value changed', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/memory.*consumption/i)).toHaveValue(400));
    await userEvent.clear(screen.getByLabelText(/memory.*consumption/i));
    await userEvent.type(screen.getByLabelText(/memory.*consumption/i), '500');
    await userEvent.click(screen.getByRole('button', { name: /save baseline/i }));
    await userEvent.click(screen.getByRole('button', { name: /rewrite baseline/i }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(CLUSTER_ID, {
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 500, baselineCapacity: 1000 },
        ],
      });
    });
  });

  it('includes baselineDate in PUT when only the date changed', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/baseline date/i)).toHaveValue('2026-05-01'));
    const dateInput = screen.getByLabelText(/baseline date/i);
    await userEvent.clear(dateInput);
    await userEvent.type(dateInput, '2026-06-01');
    await userEvent.click(screen.getByRole('button', { name: /save baseline/i }));
    await userEvent.click(screen.getByRole('button', { name: /rewrite baseline/i }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(CLUSTER_ID, { baselineDate: '2026-06-01' });
    });
  });
});
