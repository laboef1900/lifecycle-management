import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api } from '@/lib/api-client';

import { ThresholdOverridesForm } from './threshold-overrides-form';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const CLUSTER_ID = 'clu_test_001';

function renderWithClient(
  ui: React.ReactNode,
  client: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  return { ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>), client };
}

describe('<ThresholdOverridesForm>', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.cluster, 'get').mockResolvedValue({
      warnThreshold: null,
      critThreshold: null,
      effective: { warn: 0.7, crit: 0.9, source: 'tenant' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows "Inherited from tenant defaults" when no override', async () => {
    renderWithClient(<ThresholdOverridesForm clusterId={CLUSTER_ID} />);
    await waitFor(() => {
      expect(screen.getByText(/inherited from tenant defaults/i)).toBeInTheDocument();
    });
  });

  it('shows inherited values as placeholders', async () => {
    renderWithClient(<ThresholdOverridesForm clusterId={CLUSTER_ID} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/warn %/i)).toHaveAttribute('placeholder', '70');
      expect(screen.getByLabelText(/crit %/i)).toHaveAttribute('placeholder', '90');
    });
  });

  it('disables Save when no fields populated', async () => {
    renderWithClient(<ThresholdOverridesForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /save override/i })).toBeDisabled();
  });

  it('flips source pill to "Cluster override" after saving', async () => {
    vi.spyOn(api.settings.cluster, 'update').mockResolvedValue({
      warnThreshold: 0.6,
      critThreshold: null,
      effective: { warn: 0.6, crit: 0.9, source: 'cluster' },
    });
    renderWithClient(<ThresholdOverridesForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText(/warn %/i), '60');
    await userEvent.click(screen.getByRole('button', { name: /save override/i }));
    await waitFor(() => {
      expect(screen.getByText(/cluster override/i)).toBeInTheDocument();
    });
  });

  it('calls reset endpoint on "Reset to inherited"', async () => {
    vi.spyOn(api.settings.cluster, 'get').mockResolvedValue({
      warnThreshold: 0.6,
      critThreshold: null,
      effective: { warn: 0.6, crit: 0.9, source: 'cluster' },
    });
    vi.spyOn(api.settings.cluster, 'reset').mockResolvedValue({
      warnThreshold: null,
      critThreshold: null,
      effective: { warn: 0.7, crit: 0.9, source: 'tenant' },
    });
    renderWithClient(<ThresholdOverridesForm clusterId={CLUSTER_ID} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /reset to inherited/i })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: /reset to inherited/i }));
    await waitFor(() => {
      expect(api.settings.cluster.reset).toHaveBeenCalledWith(CLUSTER_ID);
    });
  });

  it('invalidates the forecast query for this cluster after a successful save', async () => {
    vi.spyOn(api.settings.cluster, 'update').mockResolvedValue({
      warnThreshold: 0.6,
      critThreshold: null,
      effective: { warn: 0.6, crit: 0.9, source: 'cluster' },
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(['forecast', CLUSTER_ID], { points: [] });
    renderWithClient(<ThresholdOverridesForm clusterId={CLUSTER_ID} />, client);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText(/warn %/i), '60');
    await userEvent.click(screen.getByRole('button', { name: /save override/i }));
    await waitFor(() => {
      expect(client.getQueryState(['forecast', CLUSTER_ID])?.isInvalidated).toBe(true);
    });
  });

  it('shows a toast with the API error message when saving fails', async () => {
    vi.spyOn(api.settings.cluster, 'update').mockRejectedValue(
      new ApiError(422, { error: { code: 'VALIDATION', message: 'Warn must be less than crit' } }),
    );
    renderWithClient(<ThresholdOverridesForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText(/warn %/i), '60');
    await userEvent.click(screen.getByRole('button', { name: /save override/i }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Warn must be less than crit');
    });
  });
});
