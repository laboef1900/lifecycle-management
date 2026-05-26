import type { ClusterResponse, ForecastResponse, ProcurementInfo } from '@lcm/shared';
import { describe, expect, it } from 'vitest';

import {
  collectForecastState,
  earliestOrderByFromFleet,
  type ForecastQueryLike,
} from './collect-forecast-state';

function makeCluster(id: string, name: string = id): ClusterResponse {
  return {
    id,
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
        currentConsumption: 400,
        currentCapacity: 1000,
        utilization: 0.4,
      },
    ],
  };
}

function makeForecast(
  consumption: number,
  capacity: number,
  procurement: ProcurementInfo = { leadTimeWeeks: 8, orderByDate: null, breachMonth: null },
): ForecastResponse {
  return {
    fromMonth: '2026-05-01',
    toMonth: '2026-05-01',
    events: [],
    hosts: [],
    applications: [],
    months: [
      { month: '2026-05-01', consumption, capacity, utilization: capacity > 0 ? consumption / capacity : 0 },
    ],
    effectiveThresholds: { warn: 0.7, crit: 0.9, source: 'tenant' },
    procurement,
  } as unknown as ForecastResponse;
}

function q(overrides: Partial<ForecastQueryLike> = {}): ForecastQueryLike {
  return {
    data: undefined,
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    ...overrides,
  };
}

describe('collectForecastState', () => {
  it('builds forecastsById from successful queries and skips clusters without data', () => {
    const a = makeCluster('a');
    const b = makeCluster('b');
    const state = collectForecastState(
      [a, b],
      [q({ data: makeForecast(400, 1000), isSuccess: true }), q({ isPending: true })],
    );
    expect(Object.keys(state.forecastsById)).toEqual(['a']);
    expect(state.forecastsById.a?.thresholds).toEqual({ warn: 0.7, crit: 0.9 });
  });

  it('records error messages for errored queries', () => {
    const a = makeCluster('a');
    const state = collectForecastState(
      [a],
      [q({ isError: true, error: new Error('boom') })],
    );
    expect(state.errorsById.a).toBe('boom');
  });

  it('falls back to a default message when the error is not an Error', () => {
    const a = makeCluster('a');
    const state = collectForecastState([a], [q({ isError: true, error: 'oops' })]);
    expect(state.errorsById.a).toBe('Failed to load forecast');
  });

  it('reports forecastsLoading=true when any query is pending', () => {
    const a = makeCluster('a');
    const b = makeCluster('b');
    expect(
      collectForecastState(
        [a, b],
        [q({ data: makeForecast(400, 1000), isSuccess: true }), q({ isPending: true })],
      ).forecastsLoading,
    ).toBe(true);
  });

  it('reports forecastsLoading=false when no query is pending', () => {
    const a = makeCluster('a');
    expect(
      collectForecastState([a], [q({ data: makeForecast(400, 1000), isSuccess: true })])
        .forecastsLoading,
    ).toBe(false);
  });

  it('counts responsive (isSuccess) queries', () => {
    const a = makeCluster('a');
    const b = makeCluster('b');
    const c = makeCluster('c');
    const state = collectForecastState(
      [a, b, c],
      [
        q({ data: makeForecast(400, 1000), isSuccess: true }),
        q({ isError: true, error: new Error('x') }),
        q({ data: makeForecast(200, 1000), isSuccess: true }),
      ],
    );
    expect(state.responsiveCount).toBe(2);
  });

  it('produces an aggregateFleet-equivalent summary in one pass', () => {
    const a = makeCluster('a');
    const b = makeCluster('b');
    const state = collectForecastState(
      [a, b],
      [
        q({ data: makeForecast(400, 1000), isSuccess: true }),
        q({ data: makeForecast(800, 1000), isSuccess: true }),
      ],
    );
    expect(state.summary.totalConsumption).toBe(1200);
    expect(state.summary.totalCapacity).toBe(2000);
    expect(state.summary.worstCluster?.id).toBe('b');
  });

  it('gathers per-cluster procurement info for clusters with data', () => {
    const a = makeCluster('a');
    const b = makeCluster('b');
    const state = collectForecastState(
      [a, b],
      [
        q({
          data: makeForecast(400, 1000, {
            leadTimeWeeks: 8,
            orderByDate: '2026-06-01',
            breachMonth: '2026-08-01',
          }),
          isSuccess: true,
        }),
        q({ isPending: true }),
      ],
    );
    expect(state.procurementByClusterId.a).toEqual({
      leadTimeWeeks: 8,
      orderByDate: '2026-06-01',
      breachMonth: '2026-08-01',
    });
    expect(state.procurementByClusterId.b).toBeUndefined();
  });
});

describe('earliestOrderByFromFleet', () => {
  it('returns null when no cluster has a projected breach', () => {
    const a = makeCluster('a');
    const b = makeCluster('b');
    expect(earliestOrderByFromFleet([a, b], {})).toBeNull();
    expect(
      earliestOrderByFromFleet([a], {
        a: { leadTimeWeeks: 8, orderByDate: null, breachMonth: null },
      }),
    ).toBeNull();
  });

  it('picks the cluster with the lexicographically-earliest orderByDate', () => {
    const a = makeCluster('a');
    const b = makeCluster('b');
    const c = makeCluster('c');
    const result = earliestOrderByFromFleet([a, b, c], {
      a: { leadTimeWeeks: 8, orderByDate: '2026-09-01', breachMonth: '2026-11-01' },
      b: { leadTimeWeeks: 8, orderByDate: '2026-07-15', breachMonth: '2026-09-09' },
      c: { leadTimeWeeks: 8, orderByDate: null, breachMonth: null },
    });
    expect(result?.cluster.id).toBe('b');
    expect(result?.procurement.orderByDate).toBe('2026-07-15');
  });

  it('skips clusters whose procurement entry is missing entirely', () => {
    const a = makeCluster('a');
    const b = makeCluster('b');
    const result = earliestOrderByFromFleet([a, b], {
      b: { leadTimeWeeks: 4, orderByDate: '2026-08-10', breachMonth: '2026-09-07' },
    });
    expect(result?.cluster.id).toBe('b');
  });
});
