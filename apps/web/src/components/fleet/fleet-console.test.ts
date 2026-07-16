import type { ClusterResponse, ProcurementInfo } from '@lcm/shared';
import { describe, expect, it } from 'vitest';

import { sortClustersByUrgency } from './fleet-console';

function cluster(id: string, name: string): ClusterResponse {
  return {
    id,
    name,
    description: null,
    baselineDate: '2026-06-01',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archivedAt: null,
    metrics: [],
  };
}

function procurement(orderByDate: string | null): ProcurementInfo {
  return { leadTimeWeeks: 13, orderByDate, breachMonth: orderByDate ? '2027-01-01' : null };
}

describe('sortClustersByUrgency', () => {
  it('orders by ascending order-by date, with null order-bys last', () => {
    const entries = [
      {
        cluster: cluster('p2', 'CL-Prod-P2'),
        procurement: procurement('2026-10-03'),
        runwayMonths: 6,
      },
      {
        cluster: cluster('none', 'CL-Dev'),
        procurement: procurement(null),
        runwayMonths: null,
      },
      {
        cluster: cluster('oracle', 'CL-Prod-P2-Oracle'),
        procurement: procurement('2026-09-14'),
        runwayMonths: 5,
      },
    ];
    const sorted = sortClustersByUrgency(entries);
    expect(sorted.map((e) => e.cluster.id)).toEqual(['oracle', 'p2', 'none']);
  });

  it('breaks ties on the same order-by date using runway months', () => {
    const entries = [
      { cluster: cluster('a', 'A'), procurement: procurement('2026-09-14'), runwayMonths: 8 },
      { cluster: cluster('b', 'B'), procurement: procurement('2026-09-14'), runwayMonths: 3 },
    ];
    const sorted = sortClustersByUrgency(entries);
    expect(sorted.map((e) => e.cluster.id)).toEqual(['b', 'a']);
  });

  it('breaks ties among null order-bys using runway months', () => {
    const entries = [
      { cluster: cluster('a', 'A'), procurement: undefined, runwayMonths: 24 },
      { cluster: cluster('b', 'B'), procurement: undefined, runwayMonths: 12 },
    ];
    const sorted = sortClustersByUrgency(entries);
    expect(sorted.map((e) => e.cluster.id)).toEqual(['b', 'a']);
  });

  it('does not mutate the input array', () => {
    const entries = [
      { cluster: cluster('a', 'A'), procurement: procurement('2026-12-01'), runwayMonths: 1 },
      { cluster: cluster('b', 'B'), procurement: procurement('2026-09-01'), runwayMonths: 1 },
    ];
    const original = [...entries];
    sortClustersByUrgency(entries);
    expect(entries).toEqual(original);
  });
});
