import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ClusterForecastEntry } from '@/lib/forecast-summary';

import { FleetUtilizationHeatmap } from './fleet-utilization-heatmap';

function makeCluster(name: string, utilization: number): ClusterResponse {
  return {
    id: `c-${name}`,
    name,
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
        baselineConsumption: utilization * 1000,
        baselineCapacity: 1000,
        currentConsumption: utilization * 1000,
        currentCapacity: 1000,
        utilization,
      },
    ],
  };
}

function entry(
  name: string,
  months: ForecastMonthPoint[],
  thresholds = { warn: 0.7, crit: 0.9 },
  currentUtilization = 0.4,
): ClusterForecastEntry {
  return {
    cluster: makeCluster(name, currentUtilization),
    months,
    thresholds,
    summary: { months: null, alreadyBreached: false },
  };
}

describe('<FleetUtilizationHeatmap>', () => {
  it('renders one row per cluster sorted by current utilization desc', () => {
    const entries: ClusterForecastEntry[] = [
      entry('Low', [], undefined, 0.2),
      entry('Hot', [], undefined, 0.92),
      entry('Mid', [], undefined, 0.55),
    ];
    render(<FleetUtilizationHeatmap entries={entries} />);
    const rowHeaders = screen.getAllByRole('rowheader').map((h) => h.textContent);
    expect(rowHeaders).toEqual(['Hot', 'Mid', 'Low']);
  });

  it('breaks ties on current utilization alphabetically by cluster name', () => {
    const entries: ClusterForecastEntry[] = [
      entry('Beta', [], undefined, 0.5),
      entry('Alpha', [], undefined, 0.5),
    ];
    render(<FleetUtilizationHeatmap entries={entries} />);
    const rowHeaders = screen.getAllByRole('rowheader').map((h) => h.textContent);
    expect(rowHeaders).toEqual(['Alpha', 'Beta']);
  });

  it("colors cells by utStatus using the cluster's own thresholds", () => {
    const months: ForecastMonthPoint[] = [
      { month: '2026-05-01', consumption: 460, capacity: 1000, utilization: 0.46 },
    ];
    // Cluster with custom 45/48 thresholds — 0.46 is already warn.
    const entries: ClusterForecastEntry[] = [
      entry('Custom', months, { warn: 0.45, crit: 0.48 }, 0.46),
    ];
    render(<FleetUtilizationHeatmap entries={entries} />);
    const cell = screen.getByTestId('cell-c-Custom-2026-05-01');
    expect(cell.dataset.status).toBe('warn');
  });

  it('marks months with no point for a cluster as empty', () => {
    const entries: ClusterForecastEntry[] = [
      entry('Sparse', [
        { month: '2026-05-01', consumption: 200, capacity: 1000, utilization: 0.2 },
      ]),
      entry('Dense', [
        { month: '2026-05-01', consumption: 200, capacity: 1000, utilization: 0.2 },
        { month: '2026-06-01', consumption: 200, capacity: 1000, utilization: 0.2 },
      ]),
    ];
    render(<FleetUtilizationHeatmap entries={entries} />);
    expect(screen.getByTestId('cell-c-Sparse-2026-06-01').dataset.status).toBe('empty');
  });

  it('gives each cell an aria-label with month, percent, and status', () => {
    const months: ForecastMonthPoint[] = [
      { month: '2026-05-01', consumption: 480, capacity: 1000, utilization: 0.48 },
    ];
    const entries: ClusterForecastEntry[] = [
      entry('Custom', months, { warn: 0.45, crit: 0.48 }, 0.48),
    ];
    render(<FleetUtilizationHeatmap entries={entries} />);
    expect(screen.getByLabelText(/May 2026 — 48\.0% \(crit\)/)).toBeInTheDocument();
  });

  it('renders a skeleton when isLoading and no entries are given', () => {
    render(<FleetUtilizationHeatmap entries={[]} isLoading />);
    expect(screen.getByTestId('heatmap-skeleton')).toBeInTheDocument();
  });

  it('renders nothing for an empty non-loading entries list', () => {
    const { container } = render(<FleetUtilizationHeatmap entries={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a "(failed)" marker next to the cluster name when the entry has an error', () => {
    const entries: ClusterForecastEntry[] = [entry('Errored', [], undefined, 0)];
    entries[0]!.error = 'timeout';
    render(<FleetUtilizationHeatmap entries={entries} />);
    expect(screen.getByText(/\(failed\)/i)).toBeInTheDocument();
  });
});
