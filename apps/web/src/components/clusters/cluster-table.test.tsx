import type { ClusterResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ClusterTable } from './cluster-table';

// Avoid bringing the entire TanStack Router runtime into a unit test; the
// table only needs Link to render an anchor.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => <a href={renderHref(to, params)}>{children}</a>,
}));

function renderHref(to: string, params?: Record<string, string>): string {
  if (!params) return to;
  let out = to;
  for (const [key, value] of Object.entries(params)) {
    out = out.replace(`$${key}`, value);
  }
  return out;
}

// Sparkline cell fires its own forecast query — short-circuit it for these tests.
vi.mock('./cluster-sparkline-cell', () => ({
  ClusterSparklineCell: () => null,
}));

const makeCluster = (
  overrides: Partial<ClusterResponse> & {
    metric: { consumption: number; capacity: number };
  },
): ClusterResponse => ({
  id: overrides.id ?? `c-${overrides.name}`,
  name: overrides.name ?? 'cluster',
  description: null,
  baselineDate: '2026-05-01',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  metrics: [
    {
      metricTypeKey: 'memory_gb',
      metricTypeDisplayName: 'Memory',
      unit: 'GB',
      baselineConsumption: overrides.metric.consumption,
      baselineCapacity: overrides.metric.capacity,
      currentConsumption: overrides.metric.consumption,
      currentCapacity: overrides.metric.capacity,
      utilization:
        overrides.metric.capacity === 0
          ? 0
          : overrides.metric.consumption / overrides.metric.capacity,
    },
  ],
});

function renderTable(clusters: ClusterResponse[]): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ClusterTable clusters={clusters} />
    </QueryClientProvider>,
  );
}

function visibleNames(): string[] {
  const rows = screen.getAllByRole('row').slice(1); // drop header row
  return rows.map((row) => {
    const firstCell = within(row).getAllByRole('cell')[0];
    return firstCell?.textContent?.trim() ?? '';
  });
}

describe('ClusterTable sorting', () => {
  const clusters = [
    makeCluster({ name: 'Cluster-B', metric: { consumption: 200, capacity: 1000 } }),
    makeCluster({ name: 'Cluster-A', metric: { consumption: 900, capacity: 1000 } }),
    makeCluster({ name: 'Cluster-C', metric: { consumption: 500, capacity: 1000 } }),
  ];

  it('renders clusters sorted by name ascending by default', () => {
    renderTable(clusters);
    expect(visibleNames()).toEqual(['Cluster-A', 'Cluster-B', 'Cluster-C']);
  });

  it('toggles to name descending when the cluster header is clicked', async () => {
    const user = userEvent.setup();
    renderTable(clusters);
    await user.click(screen.getByRole('button', { name: 'Cluster' }));
    expect(visibleNames()).toEqual(['Cluster-C', 'Cluster-B', 'Cluster-A']);
  });

  it('sorts by utilization ascending then descending', async () => {
    const user = userEvent.setup();
    renderTable(clusters);

    await user.click(screen.getByRole('button', { name: 'Utilization' }));
    expect(visibleNames()).toEqual(['Cluster-B', 'Cluster-C', 'Cluster-A']);

    await user.click(screen.getByRole('button', { name: 'Utilization' }));
    expect(visibleNames()).toEqual(['Cluster-A', 'Cluster-C', 'Cluster-B']);
  });

  it('sorts by current consumption ascending', async () => {
    const user = userEvent.setup();
    renderTable(clusters);
    await user.click(screen.getByRole('button', { name: 'Consumption (GB)' }));
    expect(visibleNames()).toEqual(['Cluster-B', 'Cluster-C', 'Cluster-A']);
  });
});
