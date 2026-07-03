import type { ClusterResponse, ForecastResponse } from '@lcm/shared';
import { describe, expect, test } from 'vitest';

import { aggregateFleet } from '@/lib/aggregate-fleet';

function makeCluster(id: string, name: string): ClusterResponse {
  return {
    id,
    name,
    description: null,
    baselineDate: '2026-01-01',
    tenantId: 'default',
    metrics: [],
  } as unknown as ClusterResponse;
}

function makeForecast(rows: Array<[string, number, number]>): ForecastResponse {
  return {
    fromMonth: rows[0]?.[0] ?? '2026-01-01',
    toMonth: rows[rows.length - 1]?.[0] ?? '2026-01-01',
    events: [],
    hosts: [],
    applications: [],
    months: rows.map(([month, consumption, capacity]) => ({
      month,
      consumption,
      capacity,
      utilization: capacity > 0 ? consumption / capacity : 0,
    })),
    effectiveThresholds: { warn: 0.7, crit: 0.9, source: 'tenant' },
    procurement: { leadTimeWeeks: 8, orderByDate: null, breachMonth: null },
  };
}

describe('aggregateFleet', () => {
  test('empty cluster list yields zeroes', () => {
    const r = aggregateFleet([], []);
    expect(r.totalConsumption).toBe(0);
    expect(r.totalCapacity).toBe(0);
    expect(r.utilization).toBe(0);
    expect(r.clusterCount).toBe(0);
    expect(r.worstCluster).toBeNull();
    expect(r.perClusterSeries).toEqual([]);
    expect(r.fleetMonths).toEqual([]);
  });

  test('single cluster sums to its own forecast', () => {
    const c = makeCluster('a', 'A');
    const f = makeForecast([
      ['2026-01-01', 100, 500],
      ['2026-02-01', 120, 500],
    ]);
    const r = aggregateFleet([c], [{ clusterId: 'a', data: f }]);
    // Headline KPIs report CURRENT month (row[0], not end of forecast)
    expect(r.totalConsumption).toBe(100);
    expect(r.totalCapacity).toBe(500);
    expect(r.utilization).toBeCloseTo(0.2, 5);
    expect(r.clusterCount).toBe(1);
    expect(r.worstCluster?.id).toBe('a');
    expect(r.worstCluster?.utilization).toBeCloseTo(0.2, 5);
    expect(r.fleetMonths).toHaveLength(2);
    expect(r.fleetMonths[1]).toMatchObject({
      month: '2026-02-01',
      capacityTotal: 500,
      a: 120,
    });
  });

  test('multi-cluster sums per month and picks worst', () => {
    const a = makeCluster('a', 'A');
    const b = makeCluster('b', 'B');
    const fa = makeForecast([
      ['2026-01-01', 100, 1000],
      ['2026-02-01', 200, 1000],
    ]);
    const fb = makeForecast([
      ['2026-01-01', 400, 500],
      ['2026-02-01', 450, 500],
    ]);
    const r = aggregateFleet(
      [a, b],
      [
        { clusterId: 'a', data: fa },
        { clusterId: 'b', data: fb },
      ],
    );
    // Headline KPIs report CURRENT month (row[0], not end of forecast)
    expect(r.totalConsumption).toBe(500);
    expect(r.totalCapacity).toBe(1500);
    expect(r.utilization).toBeCloseTo(500 / 1500, 5);
    expect(r.worstCluster?.id).toBe('b');
    expect(r.worstCluster?.utilization).toBeCloseTo(0.8, 5);
    expect(r.fleetMonths[1]).toMatchObject({
      month: '2026-02-01',
      capacityTotal: 1500,
      a: 200,
      b: 450,
    });
  });

  test('missing forecast for a cluster — cluster present but contributes nothing', () => {
    const a = makeCluster('a', 'A');
    const b = makeCluster('b', 'B');
    const fa = makeForecast([['2026-01-01', 100, 500]]);
    const r = aggregateFleet(
      [a, b],
      [
        { clusterId: 'a', data: fa },
        { clusterId: 'b', data: undefined },
      ],
    );
    expect(r.totalConsumption).toBe(100);
    expect(r.totalCapacity).toBe(500);
    expect(r.clusterCount).toBe(2);
    expect(r.worstCluster?.id).toBe('a');
    expect(r.perClusterSeries).toHaveLength(2);
    expect(r.perClusterSeries[1]?.months).toEqual([]);
  });

  test('zero-capacity cluster does not divide by zero', () => {
    const a = makeCluster('a', 'A');
    const fa = makeForecast([['2026-01-01', 0, 0]]);
    const r = aggregateFleet([a], [{ clusterId: 'a', data: fa }]);
    expect(r.utilization).toBe(0);
    expect(r.worstCluster?.utilization).toBe(0);
  });
});
