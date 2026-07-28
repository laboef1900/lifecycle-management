import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Scenario } from '@lcm/shared';

import type { ForecastApplication, ForecastHost, ForecastInput } from '../forecast.js';
import { applyScenario, applyScenarioStack } from '../scenario.js';

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
    const r = applyScenario(input, { kind: 'lose_hosts', count: 1 }, 0);
    expect(r.hosts.map((h) => h.id).sort()).toEqual(['med', 'small']);
  });

  it('drops all hosts when count >= total (does not error)', () => {
    const input = makeInput([makeHost('a', 100), makeHost('b', 200)]);
    const r = applyScenario(input, { kind: 'lose_hosts', count: 5 }, 0);
    expect(r.hosts).toEqual([]);
  });

  it('treats hosts with no capacity at window start as size 0 (drops them last)', () => {
    // "future" host has capacity but only starting July; at baselineDate it
    // contributes 0 and shouldn't be picked as the "biggest" to drop.
    const future = makeHost('future', 9999, { capEffective: new Date('2026-07-01T00:00:00Z') });
    const input = makeInput([makeHost('now', 500), future]);
    const r = applyScenario(input, { kind: 'lose_hosts', count: 1 }, 0);
    expect(r.hosts.map((h) => h.id)).toEqual(['future']);
  });

  it('does not mutate the original input', () => {
    const input = makeInput([makeHost('a', 100), makeHost('b', 200)]);
    applyScenario(input, { kind: 'lose_hosts', count: 1 }, 0);
    expect(input.hosts).toHaveLength(2);
  });
});

describe('applyScenario — add_vms', () => {
  it('appends a synthetic Application with count*sizeGb allocation', () => {
    const input = makeInput([], [makeApp('existing', 200)]);
    const r = applyScenario(
      input,
      {
        kind: 'add_vms',
        count: 30,
        sizeGb: 16,
        startMonth: new Date('2026-06-01T00:00:00.000Z'),
      },
      0,
    );
    expect(r.applications).toHaveLength(2);
    const scenario = r.applications[1]!;
    expect(scenario.name).toMatch(/30.*16/);
    expect(scenario.allocations[0]?.amount).toBe(480);
    expect(scenario.startedAt.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('defaults startedAt to now when startMonth is omitted', () => {
    const before = Date.now();
    const r = applyScenario(makeInput(), { kind: 'add_vms', count: 1, sizeGb: 8 }, 0);
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
    const r = applyScenario(makeInput([future]), { kind: 'delay_procurement', months: 2 }, 0);
    expect(r.hosts[0]!.commissionedAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('shifts projectedDecommissionAt on the same hosts by the same months', () => {
    const future = makeHost('upcoming', 500, {
      commissionedAt: new Date('2026-09-01T00:00:00Z'),
      projDecom: new Date('2030-09-01T00:00:00Z'),
    });
    const r = applyScenario(makeInput([future]), { kind: 'delay_procurement', months: 3 }, 0);
    expect(r.hosts[0]!.projectedDecommissionAt!.toISOString()).toBe('2030-12-01T00:00:00.000Z');
  });

  it('clamps month-end dates instead of drifting into the next month', () => {
    const future = makeHost('upcoming', 500, {
      commissionedAt: new Date('2026-08-31T00:00:00Z'),
    });
    const r = applyScenario(makeInput([future]), { kind: 'delay_procurement', months: 1 }, 0);
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
    const r = applyScenario(input, { kind: 'delay_procurement', months: 6 }, 0);
    expect(r.events).toEqual(input.events);
  });

  it('leaves already-deployed hosts untouched', () => {
    const past = makeHost('deployed', 500, {
      commissionedAt: new Date('2020-01-01T00:00:00Z'),
    });
    const r = applyScenario(makeInput([past]), { kind: 'delay_procurement', months: 6 }, 0);
    expect(r.hosts[0]!.commissionedAt.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('is a no-op when there are no future commissions to delay', () => {
    const past = makeHost('deployed', 500, {
      commissionedAt: new Date('2020-01-01T00:00:00Z'),
    });
    const r = applyScenario(makeInput([past]), { kind: 'delay_procurement', months: 6 }, 0);
    expect(r).toEqual(makeInput([past]));
  });
});

describe('applyScenarioStack — compound what-ifs (#323)', () => {
  // `delayFutureCommissions` compares commissionedAt against `new Date()` and
  // `addSyntheticVms` defaults startedAt to it, so the clock is pinned — same
  // reason forecast-characterization.test.ts pins it.
  const NOW = new Date('2026-06-15T12:00:00.000Z');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const FUTURE = new Date('2026-09-01T00:00:00Z');

  /** One host of each disposition plus an app, so every kind has something to bite. */
  function compoundInput(): ForecastInput {
    return makeInput(
      [
        makeHost('big-deployed', 2048, { commissionedAt: new Date('2025-01-01T00:00:00Z') }),
        makeHost('small-deployed', 128, { commissionedAt: new Date('2025-01-01T00:00:00Z') }),
        makeHost('future', 512, {
          commissionedAt: FUTURE,
          projDecom: new Date('2031-09-01T00:00:00Z'),
          capEffective: FUTURE,
        }),
      ],
      [makeApp('app-1', 900)],
    );
  }

  const ALL_THREE: Scenario[] = [
    { kind: 'lose_hosts', count: 1 },
    { kind: 'add_vms', count: 10, sizeGb: 16, startMonth: new Date('2026-07-01T00:00:00Z') },
    { kind: 'delay_procurement', months: 3 },
  ];

  it('applies every step of the stack', () => {
    const r = applyScenarioStack(compoundInput(), ALL_THREE);

    // lose_hosts dropped the largest host…
    expect(r.hosts.map((h) => h.id)).toEqual(['small-deployed', 'future']);
    // …delay_procurement shifted the one future commission by 3 months…
    const future = r.hosts.find((h) => h.id === 'future')!;
    expect(future.commissionedAt.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(future.projectedDecommissionAt?.toISOString()).toBe('2031-12-01T00:00:00.000Z');
    // …and add_vms appended one synthetic application of count × sizeGb.
    expect(r.applications).toHaveLength(2);
    const synthetic = r.applications[1]!;
    expect(synthetic.allocations[0]!.amount).toBe(160);
    expect(synthetic.name).toBe('Scenario: +10 × 16 GB');
  });

  it('is a single step when handed one — the back-compat path', () => {
    const single = applyScenarioStack(compoundInput(), [{ kind: 'lose_hosts', count: 1 }]);
    expect(single).toEqual(applyScenario(compoundInput(), { kind: 'lose_hosts', count: 1 }, 0));
  });

  const permute = <T>(xs: T[]): T[][] =>
    xs.length <= 1
      ? [xs]
      : xs.flatMap((x, i) =>
          permute([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
        );

  /**
   * INV-5, part 1: the PUBLIC guarantee. A caller gets the same answer whatever
   * order it serialises the steps in.
   *
   * @ai-warning This one is true BY CONSTRUCTION — `applyScenarioStack` sorts
   * before folding, so its output is a pure function of the step multiset and this
   * assertion cannot fail for non-commutativity. It is here to pin the sort (delete
   * the `.sort()` and it goes red), NOT to detect a non-commuting kind. The test
   * below is the one that does that. Corrected after AI review pointed out the
   * original single test was claiming a tripwire it could never trip.
   */
  it('gives the same answer for all six step orders, including array ordering', () => {
    const orders = permute(ALL_THREE);
    expect(orders).toHaveLength(6);

    const canonical = JSON.stringify(applyScenarioStack(compoundInput(), ALL_THREE));
    for (const order of orders) {
      expect(
        JSON.stringify(applyScenarioStack(compoundInput(), order)),
        `order ${order.map((s) => s.kind).join(' → ')} diverged`,
      ).toBe(canonical);
    }
  });

  /**
   * INV-5, part 2: the transforms THEMSELVES commute — folded raw, bypassing the
   * canonical sort. This is the assertion that can actually fail: add a kind that
   * rewrites state another kind reads (e.g. one that scales `host.capacities`,
   * which is what `lose_hosts` ranks by) and this goes red while the sorted test
   * above stays green.
   *
   * Why it matters even though the sort makes the public answer stable: the day
   * the transforms stop commuting, `STEP_ORDER` stops being an arbitrary
   * tie-break and starts *deciding the forecast*. That is a decision an author
   * must make deliberately, not inherit from whatever order the literal happened
   * to be written in.
   */
  it('the transforms themselves commute, folded without the canonical sort', () => {
    const rawFold = (order: readonly Scenario[]): string =>
      JSON.stringify(order.reduce((acc, step) => applyScenario(acc, step, 0), compoundInput()));

    const orders = permute(ALL_THREE);
    const reference = rawFold(ALL_THREE);
    for (const order of orders) {
      expect(
        rawFold(order),
        `raw fold ${order.map((s) => s.kind).join(' → ')} diverged — a kind no longer commutes, so STEP_ORDER now decides the forecast`,
      ).toBe(reference);
    }
  });

  it('folds in canonical order (lose → add → delay) whatever order it receives', () => {
    // A host that is future-commissioned but whose capacity row is already
    // effective: lose_hosts ranks it by that row, so it is the one dropped no
    // matter when delay_procurement runs. If the fold ever consulted
    // commissionedAt for ranking, reversing the steps would drop a different host.
    const input = makeInput([
      makeHost('big-but-future', 2048, {
        commissionedAt: FUTURE,
        capEffective: new Date('2025-01-01T00:00:00Z'),
      }),
      makeHost('small-deployed', 128, { commissionedAt: new Date('2025-01-01T00:00:00Z') }),
    ]);
    const steps: Scenario[] = [
      { kind: 'delay_procurement', months: 6 },
      { kind: 'lose_hosts', count: 1 },
    ];
    const r = applyScenarioStack(input, steps);
    expect(r.hosts.map((h) => h.id)).toEqual(['small-deployed']);
  });

  it('does not mutate the input across steps (INV-2)', () => {
    const input = compoundInput();
    const before = JSON.stringify(input);
    applyScenarioStack(input, ALL_THREE);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('scopes the synthetic application id per step so contributions cannot alias', () => {
    // The schema forbids two add_vms steps, so this asserts the second,
    // structural defence directly: the id carries the step index it was minted
    // at. The engine keys per-application contributions on a Map<id, …>, so a
    // shared id would hand two response entries the same aliased array.
    const one = applyScenarioStack(compoundInput(), [{ kind: 'add_vms', count: 1, sizeGb: 8 }]);
    const second = applyScenarioStack(compoundInput(), [
      { kind: 'lose_hosts', count: 1 },
      { kind: 'add_vms', count: 1, sizeGb: 8 },
    ]);
    const idOf = (i: ForecastInput): string => i.applications.at(-1)!.id;
    expect(idOf(one)).toBe('__scenario:0:add_vms:1x8');
    expect(idOf(second)).toBe('__scenario:1:add_vms:1x8');
    expect(idOf(one)).not.toBe(idOf(second));
  });

  it('defaults the synthetic startedAt to the pinned clock when startMonth is omitted', () => {
    const r = applyScenarioStack(compoundInput(), [{ kind: 'add_vms', count: 2, sizeGb: 32 }]);
    expect(r.applications.at(-1)!.startedAt.toISOString()).toBe(NOW.toISOString());
  });
});
