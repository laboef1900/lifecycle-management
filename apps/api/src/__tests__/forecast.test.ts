import { describe, expect, it } from 'vitest';

import {
  computeForecast,
  type ForecastApplication,
  type ForecastEvent,
  type ForecastHost,
  type ForecastInput,
} from '../services/forecast.js';

const d = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

const event = (
  id: string,
  date: string,
  category: 'growth' | 'hardware_change' | 'openshift' | 'note',
  title: string,
  consumptionDelta: number | null,
  capacityDelta: number | null,
): ForecastEvent => ({
  id,
  effectiveDate: d(date),
  category,
  title,
  description: null,
  consumptionDelta,
  capacityDelta,
});

describe('computeForecast — CL-DMZ-P1 vs original spreadsheet', () => {
  const input: ForecastInput = {
    baselineDate: d('2026-05-01'),
    baselineConsumption: 3378,
    baselineCapacity: 7680,
    hosts: [],
    applications: [],
    events: [
      event('e1', '2026-09-01', 'openshift', 'OpenShift - Aufbau Labor Umgebung (DMZ)', 144, null),
      event('e2', '2026-10-01', 'growth', 'Wachstum Q4', 375, null),
      event('e3', '2026-10-01', 'hardware_change', 'Ausbau Memory HPE-Server', null, 2560),
      event('e4', '2026-11-01', 'openshift', 'OpenShift - Aufbau Test Umgebung (DMZ)', 432, null),
      event('e5', '2026-12-01', 'hardware_change', 'Ausbau 2x HPE Server', null, 4096),
      event('e6', '2027-01-01', 'growth', 'Wachstum Q1', 375, null),
      event('e7', '2027-01-01', 'openshift', 'OpenShift - Aufbau Prod Umgebung (DMZ)', 880, null),
      event('e8', '2027-04-01', 'growth', 'Wachstum Q2', 375, null),
      event('e9', '2027-05-01', 'hardware_change', 'Ausbau 2x HPE Server', null, 4096),
      event('e10', '2027-06-01', 'openshift', 'Ausbau - OpenShift Cluster Expansion', 384, null),
      event('e11', '2027-07-01', 'growth', 'Wachstum Q3', 375, null),
      event('e12', '2027-10-01', 'growth', 'Wachstum Q4', 375, null),
    ],
  };

  const expected: Array<{ month: string; consumption: number; capacity: number }> = [
    { month: '2026-05-01', consumption: 3378, capacity: 7680 },
    { month: '2026-06-01', consumption: 3378, capacity: 7680 },
    { month: '2026-07-01', consumption: 3378, capacity: 7680 },
    { month: '2026-08-01', consumption: 3378, capacity: 7680 },
    { month: '2026-09-01', consumption: 3522, capacity: 7680 },
    { month: '2026-10-01', consumption: 3897, capacity: 10240 },
    { month: '2026-11-01', consumption: 4329, capacity: 10240 },
    { month: '2026-12-01', consumption: 4329, capacity: 14336 },
    { month: '2027-01-01', consumption: 5584, capacity: 14336 },
    { month: '2027-02-01', consumption: 5584, capacity: 14336 },
    { month: '2027-03-01', consumption: 5584, capacity: 14336 },
    { month: '2027-04-01', consumption: 5959, capacity: 14336 },
    { month: '2027-05-01', consumption: 5959, capacity: 18432 },
    { month: '2027-06-01', consumption: 6343, capacity: 18432 },
    { month: '2027-07-01', consumption: 6718, capacity: 18432 },
    { month: '2027-08-01', consumption: 6718, capacity: 18432 },
    { month: '2027-09-01', consumption: 6718, capacity: 18432 },
    { month: '2027-10-01', consumption: 7093, capacity: 18432 },
    { month: '2027-11-01', consumption: 7093, capacity: 18432 },
    { month: '2027-12-01', consumption: 7093, capacity: 18432 },
  ];

  const result = computeForecast(input, d('2026-05-01'), d('2027-12-01'));

  it('produces 20 months covering 2026-05 → 2027-12', () => {
    expect(result.months).toHaveLength(20);
  });

  for (const { month, consumption, capacity } of expected) {
    it(`matches the spreadsheet at ${month} (cons=${consumption}, cap=${capacity})`, () => {
      const actual = result.months.find((m) => m.month === month);
      expect(actual).toBeDefined();
      expect(actual?.consumption).toBe(consumption);
      expect(actual?.capacity).toBe(capacity);
      const expectedUtilization = consumption / capacity;
      expect(actual?.utilization).toBeCloseTo(expectedUtilization, 6);
    });
  }

  it('lists every event that falls inside the window', () => {
    expect(result.events).toHaveLength(12);
    expect(result.events[0]).toMatchObject({
      effectiveDate: '2026-09-01',
      title: 'OpenShift - Aufbau Labor Umgebung (DMZ)',
      category: 'openshift',
      consumptionDelta: 144,
    });
  });
});

describe('computeForecast — hosts and applications', () => {
  const baseInput: Omit<ForecastInput, 'hosts' | 'applications' | 'events'> = {
    baselineDate: d('2026-01-01'),
    baselineConsumption: 0,
    baselineCapacity: 0,
  };

  it('adds host capacity from the commission date onward', () => {
    const host: ForecastHost = {
      id: 'h1',
      name: 'HPE-01',
      commissionedAt: d('2026-03-01'),
      decommissionedAt: null,
      capacities: [{ effectiveFrom: d('2026-03-01'), amount: 512 }],
    };
    const result = computeForecast(
      { ...baseInput, hosts: [host], applications: [], events: [] },
      d('2026-01-01'),
      d('2026-05-01'),
    );
    const amounts = result.months.map((m) => m.capacity);
    expect(amounts).toEqual([0, 0, 512, 512, 512]);
  });

  it('respects host resize timeline (most recent effectiveFrom wins)', () => {
    const host: ForecastHost = {
      id: 'h1',
      name: 'HPE-01',
      commissionedAt: d('2026-01-01'),
      decommissionedAt: null,
      capacities: [
        { effectiveFrom: d('2026-01-01'), amount: 256 },
        { effectiveFrom: d('2026-04-01'), amount: 512 },
      ],
    };
    const result = computeForecast(
      { ...baseInput, hosts: [host], applications: [], events: [] },
      d('2026-01-01'),
      d('2026-06-01'),
    );
    expect(result.months.map((m) => m.capacity)).toEqual([256, 256, 256, 512, 512, 512]);
  });

  it('drops a decommissioned host on the decommission date', () => {
    const host: ForecastHost = {
      id: 'h1',
      name: 'HPE-01',
      commissionedAt: d('2026-01-01'),
      decommissionedAt: d('2026-04-01'),
      capacities: [{ effectiveFrom: d('2026-01-01'), amount: 256 }],
    };
    const result = computeForecast(
      { ...baseInput, hosts: [host], applications: [], events: [] },
      d('2026-01-01'),
      d('2026-06-01'),
    );
    expect(result.months.map((m) => m.capacity)).toEqual([256, 256, 256, 0, 0, 0]);
  });

  it('adds application allocation between started_at and ended_at exclusive', () => {
    const app: ForecastApplication = {
      id: 'a1',
      name: 'OpenShift',
      startedAt: d('2026-02-01'),
      endedAt: d('2026-05-01'),
      allocations: [{ effectiveFrom: d('2026-02-01'), amount: 144 }],
    };
    const result = computeForecast(
      { ...baseInput, hosts: [], applications: [app], events: [] },
      d('2026-01-01'),
      d('2026-06-01'),
    );
    expect(result.months.map((m) => m.consumption)).toEqual([0, 144, 144, 144, 0, 0]);
  });

  it('reports per-entity contributions across months', () => {
    const host: ForecastHost = {
      id: 'h1',
      name: 'HPE-01',
      commissionedAt: d('2026-01-01'),
      decommissionedAt: null,
      capacities: [{ effectiveFrom: d('2026-01-01'), amount: 256 }],
    };
    const app: ForecastApplication = {
      id: 'a1',
      name: 'OpenShift',
      startedAt: d('2026-02-01'),
      endedAt: null,
      allocations: [{ effectiveFrom: d('2026-02-01'), amount: 144 }],
    };
    const result = computeForecast(
      { ...baseInput, hosts: [host], applications: [app], events: [] },
      d('2026-01-01'),
      d('2026-03-01'),
    );
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]?.contributions).toEqual([
      { month: '2026-01-01', amount: 256 },
      { month: '2026-02-01', amount: 256 },
      { month: '2026-03-01', amount: 256 },
    ]);
    expect(result.applications[0]?.contributions).toEqual([
      { month: '2026-01-01', amount: 0 },
      { month: '2026-02-01', amount: 144 },
      { month: '2026-03-01', amount: 144 },
    ]);
  });
});

describe('computeForecast — perf', () => {
  it('handles 50 entities and 30 events in well under 100ms', () => {
    const hosts: ForecastHost[] = Array.from({ length: 25 }, (_, i) => ({
      id: `h${i}`,
      name: `host-${i}`,
      commissionedAt: d('2026-01-01'),
      decommissionedAt: null,
      capacities: [
        { effectiveFrom: d('2026-01-01'), amount: 256 },
        { effectiveFrom: d('2026-07-01'), amount: 512 },
      ],
    }));
    const apps: ForecastApplication[] = Array.from({ length: 25 }, (_, i) => ({
      id: `a${i}`,
      name: `app-${i}`,
      startedAt: d('2026-02-01'),
      endedAt: null,
      allocations: [{ effectiveFrom: d('2026-02-01'), amount: 32 }],
    }));
    const events: ForecastEvent[] = Array.from({ length: 30 }, (_, i) =>
      event(
        `ev${i}`,
        `2026-${String((i % 12) + 1).padStart(2, '0')}-01`,
        'growth',
        `g${i}`,
        10,
        null,
      ),
    );

    const start = performance.now();
    computeForecast(
      {
        baselineDate: d('2026-01-01'),
        baselineConsumption: 1000,
        baselineCapacity: 5000,
        hosts,
        applications: apps,
        events,
      },
      d('2026-01-01'),
      d('2027-12-01'),
    );
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});
