import type { ClusterResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { SettingsTab } from './settings-tab';

// ThresholdOverridesForm links to Settings' Forecasting section, and
// ClusterLifecycleCard navigates on delete — see their own test files for why
// a full RouterProvider is unnecessary machinery here.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, hash }: { children: React.ReactNode; to: string; hash?: string }) => (
    <a href={hash ? `${to}#${hash}` : to}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const CLUSTER_ID = 'clu_test_001';

const baseCluster: ClusterResponse = {
  id: CLUSTER_ID,
  name: 'CL-Test',
  description: null,
  baselineDate: '2026-05-01',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  archivedAt: null,
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

describe('<SettingsTab>', () => {
  beforeEach(() => {
    vi.spyOn(api.clusters, 'get').mockResolvedValue(baseCluster);
    vi.spyOn(api.settings.cluster, 'get').mockResolvedValue({
      warnThreshold: null,
      critThreshold: null,
      effective: { warn: 0.7, crit: 0.9, source: 'tenant' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('caps the tab column width so numeric inputs and row actions stay in one eye-span', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <SettingsTab clusterId={CLUSTER_ID} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(api.clusters.get).toHaveBeenCalled());
    expect(container.firstElementChild).toHaveClass('max-w-2xl');
  });
});
