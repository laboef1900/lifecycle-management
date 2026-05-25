import type { ClusterResponse } from '@lcm/shared';
import { describe, expect, it } from 'vitest';

import { buildClusterForecastEntries } from './forecast-summary';

function makeCluster(name: string, utilization = 0.4): ClusterResponse {
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
        baselineConsumption: 400,
        baselineCapacity: 1000,
        currentConsumption: utilization * 1000,
        currentCapacity: 1000,
        utilization,
      },
    ],
  };
}

describe('buildClusterForecastEntries', () => {
  it('omits clusters that have no forecast yet (still loading)', () => {
    const a = makeCluster('A');
    const b = makeCluster('B');
    const entries = buildClusterForecastEntries([a, b], {
      [a.id]: {
        months: [{ month: '2026-05-01', consumption: 400, capacity: 1000, utilization: 0.4 }],
        thresholds: { warn: 0.7, crit: 0.9 },
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.cluster.id).toBe(a.id);
  });

  it('computes a runway summary per cluster from its months + thresholds', () => {
    const a = makeCluster('A');
    const entries = buildClusterForecastEntries([a], {
      [a.id]: {
        months: [
          { month: '2026-05-01', consumption: 400, capacity: 1000, utilization: 0.4 },
          { month: '2026-06-01', consumption: 800, capacity: 1000, utilization: 0.8 },
        ],
        thresholds: { warn: 0.7, crit: 0.9 },
      },
    });
    // Util crosses warn (0.7) at index 1, so months = 1.
    expect(entries[0]?.summary).toEqual({ months: 1, alreadyBreached: false });
  });

  it('uses cluster-specific thresholds when computing runway, not the system defaults', () => {
    const a = makeCluster('A');
    const entries = buildClusterForecastEntries([a], {
      [a.id]: {
        months: [{ month: '2026-05-01', consumption: 460, capacity: 1000, utilization: 0.46 }],
        // Custom 45/48 thresholds — 0.46 is already over warn.
        thresholds: { warn: 0.45, crit: 0.48 },
      },
    });
    expect(entries[0]?.summary).toEqual({ months: 0, alreadyBreached: 'warn' });
  });
});
