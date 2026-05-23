import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ClusterListCard } from './cluster-list-card';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
    [key: string]: unknown;
  }) => {
    let href = to;
    for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, v);
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

const cluster: ClusterResponse = {
  id: 'c1',
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

const months: ForecastMonthPoint[] = [
  { month: '2026-05-01', consumption: 400, capacity: 1000, utilization: 0.4 },
  { month: '2026-06-01', consumption: 500, capacity: 1000, utilization: 0.5 },
];

describe('<ClusterListCard>', () => {
  it('links to the cluster detail page and renders the key metrics', () => {
    render(<ClusterListCard cluster={cluster} months={months} horizonMonths={2} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/clusters/c1');
    expect(screen.getByText('CL-Test')).toBeInTheDocument();
    expect(screen.getByText(/40\.0%/)).toBeInTheDocument();
    expect(screen.getByText(/400 \/ 1,000 GB/)).toBeInTheDocument();
    expect(screen.getByText(/2\+ mo/)).toBeInTheDocument();
  });

  it('falls back to em-dash when no metric is present', () => {
    const noMetric: ClusterResponse = { ...cluster, metrics: [] };
    render(<ClusterListCard cluster={noMetric} months={[]} horizonMonths={0} />);
    expect(screen.getByText('CL-Test')).toBeInTheDocument();
    expect(screen.getByText('No baseline')).toBeInTheDocument();
  });
});
