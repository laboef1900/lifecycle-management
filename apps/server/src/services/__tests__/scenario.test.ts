import { describe, expect, it } from 'vitest';

import type { ForecastApplication, ForecastHost, ForecastInput } from '../forecast.js';
import { applyScenario } from '../scenario.js';

function makeHost(
  id: string,
  capacityGb: number,
  opts: { commissionedAt?: Date; projDecom?: Date | null; capEffective?: Date } = {},
): ForecastHost {
  const effective = opts.capEffective ?? new Date('2026-01-01T00:00:00Z');
  return {
    id,
    name: id,
    commissionedAt: opts.commissionedAt ?? new Date('2026-01-01T00:00:00Z'),
    decommissionedAt: null,
    projectedDecommissionAt: opts.projDecom === undefined ? null : opts.projDecom,
    capacities: capacityGb > 0 ? [{ effectiveFrom: effective, amount: capacityGb }] : [],
  };
}

function makeApp(id: string, gb: number): ForecastApplication {
  return {
    id,
    name: id,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    endedAt: null,
    allocations: [{ effectiveFrom: new Date('2026-01-01T00:00:00Z'), amount: gb }],
  };
}

function makeInput(
  hosts: ForecastHost[] = [],
  applications: ForecastApplication[] = [],
): ForecastInput {
  return {
    baselineDate: new Date('2026-05-01T00:00:00Z'),
    baselineConsumption: 1000,
    baselineCapacity: 5000,
    hosts,
    applications,
    events: [],
  };
}

describe('applyScenario — lose_hosts', () => {
  it('drops the N largest hosts by capacity at the window start', () => {
    const input = makeInput([makeHost('small', 100), makeHost('big', 1000), makeHost('med', 500)]);
    const r = applyScenario(input, { kind: 'lose_hosts', count: 1 });
    expect(r.hosts.map((h) => h.id).sort()).toEqual(['med', 'small']);
  });

  it('drops all hosts when count >= total (does not error)', () => {
    const input = makeInput([makeHost('a', 100), makeHost('b', 200)]);
    const r = applyScenario(input, { kind: 'lose_hosts', count: 5 });
    expect(r.hosts).toEqual([]);
  });

  it('treats hosts with no capacity at window start as size 0 (drops them last)', () => {
    // "future" host has capacity but only starting July; at baselineDate it
    // contributes 0 and shouldn't be picked as the "biggest" to drop.
    const future = makeHost('future', 9999, { capEffective: new Date('2026-07-01T00:00:00Z') });
    const input = makeInput([makeHost('now', 500), future]);
    const r = applyScenario(input, { kind: 'lose_hosts', count: 1 });
    expect(r.hosts.map((h) => h.id)).toEqual(['future']);
  });

  it('does not mutate the original input', () => {
    const input = makeInput([makeHost('a', 100), makeHost('b', 200)]);
    applyScenario(input, { kind: 'lose_hosts', count: 1 });
    expect(input.hosts).toHaveLength(2);
  });
});

describe('applyScenario — add_vms', () => {
  it('appends a synthetic Application with count*sizeGb allocation', () => {
    const input = makeInput([], [makeApp('existing', 200)]);
    const r = applyScenario(input, {
      kind: 'add_vms',
      count: 30,
      sizeGb: 16,
      startMonth: new Date('2026-06-01T00:00:00.000Z'),
    });
    expect(r.applications).toHaveLength(2);
    const scenario = r.applications[1]!;
    expect(scenario.name).toMatch(/30.*16/);
    expect(scenario.allocations[0]?.amount).toBe(480);
    expect(scenario.startedAt.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('defaults startedAt to now when startMonth is omitted', () => {
    const before = Date.now();
    const r = applyScenario(makeInput(), { kind: 'add_vms', count: 1, sizeGb: 8 });
    const after = Date.now();
    const t = r.applications[0]!.startedAt.getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});

describe('applyScenario — delay_procurement', () => {
  it('shifts future commissionedAt by N calendar months', () => {
    const future = makeHost('upcoming', 500, {
      commissionedAt: new Date('2026-09-01T00:00:00Z'),
    });
    const r = applyScenario(makeInput([future]), { kind: 'delay_procurement', months: 2 });
    expect(r.hosts[0]!.commissionedAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('shifts projectedDecommissionAt on the same hosts by the same months', () => {
    const future = makeHost('upcoming', 500, {
      commissionedAt: new Date('2026-09-01T00:00:00Z'),
      projDecom: new Date('2030-09-01T00:00:00Z'),
    });
    const r = applyScenario(makeInput([future]), { kind: 'delay_procurement', months: 3 });
    expect(r.hosts[0]!.projectedDecommissionAt!.toISOString()).toBe('2030-12-01T00:00:00.000Z');
  });

  it('clamps month-end dates instead of drifting into the next month', () => {
    const future = makeHost('upcoming', 500, {
      commissionedAt: new Date('2026-08-31T00:00:00Z'),
    });
    const r = applyScenario(makeInput([future]), { kind: 'delay_procurement', months: 1 });
    expect(r.hosts[0]!.commissionedAt.toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  it('does not shift events (point-in-time deltas are independent of procurement)', () => {
    const input = makeInput([
      makeHost('upcoming', 500, { commissionedAt: new Date('2026-09-01T00:00:00Z') }),
    ]);
    input.events = [
      {
        id: 'e1',
        effectiveDate: new Date('2026-10-01T00:00:00Z'),
        category: 'growth',
        title: 'g',
        description: null,
        consumptionDelta: 100,
        capacityDelta: null,
      },
    ];
    const r = applyScenario(input, { kind: 'delay_procurement', months: 6 });
    expect(r.events).toEqual(input.events);
  });

  it('leaves already-deployed hosts untouched', () => {
    const past = makeHost('deployed', 500, {
      commissionedAt: new Date('2020-01-01T00:00:00Z'),
    });
    const r = applyScenario(makeInput([past]), { kind: 'delay_procurement', months: 6 });
    expect(r.hosts[0]!.commissionedAt.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('is a no-op when there are no future commissions to delay', () => {
    const past = makeHost('deployed', 500, {
      commissionedAt: new Date('2020-01-01T00:00:00Z'),
    });
    const r = applyScenario(makeInput([past]), { kind: 'delay_procurement', months: 6 });
    expect(r).toEqual(makeInput([past]));
  });
});
