import type { ItemResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { ItemsTab } from './items-tab';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeApplication(): ItemResponse {
  return {
    id: 'app-1',
    clusterId: 'cl-1',
    kind: 'application',
    name: 'openshift-lab',
    category: 'OpenShift',
    description: null,
    effectiveDate: '2026-01-15',
    endedAt: null,
    metricTypeKey: null,
    consumptionDelta: null,
    capacityDelta: null,
    allocations: [
      {
        id: 'alloc-1',
        metricTypeKey: 'memory_gb',
        metricTypeDisplayName: 'Memory',
        unit: 'GB',
        effectiveFrom: '2026-01-15',
        amount: 512,
      },
    ],
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
  };
}

function makeEvent(): ItemResponse {
  return {
    id: 'evt-1',
    clusterId: 'cl-1',
    kind: 'event',
    name: 'Wachstum Q4',
    category: 'Growth',
    description: null,
    effectiveDate: '2026-03-01',
    endedAt: null,
    metricTypeKey: 'memory_gb',
    consumptionDelta: 750,
    capacityDelta: null,
    allocations: [],
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  };
}

function renderTab(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ItemsTab clusterId="cl-1" />
    </QueryClientProvider>,
  );
}

describe('ItemsTab', () => {
  beforeEach(() => {
    vi.spyOn(api.items, 'listByCluster').mockResolvedValue([makeApplication(), makeEvent()]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders both application and event rows with type and category', async () => {
    renderTab();

    // Names of both items render.
    expect(await screen.findByText('openshift-lab')).toBeInTheDocument();
    expect(screen.getByText('Wachstum Q4')).toBeInTheDocument();

    // A Type badge for each kind.
    expect(screen.getByText('Application')).toBeInTheDocument();
    expect(screen.getByText('Event')).toBeInTheDocument();

    // Category text for each item.
    expect(screen.getByText('OpenShift')).toBeInTheDocument();
    expect(screen.getByText('Growth')).toBeInTheDocument();
  });
});
