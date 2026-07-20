import { describe, expect, it } from 'vitest';

import { computeForecast, type ForecastInput } from '../forecast.js';

function makeInput(events: ForecastInput['events']): ForecastInput {
  return {
    baselineDate: new Date('2026-05-01T00:00:00Z'),
    baselineConsumption: 1000,
    baselineCapacity: 5000,
    hosts: [],
    applications: [],
    events,
  };
}

describe('computeForecast — event semantics', () => {
  it('applies a consumption delta from its effective month onward, exactly once per month', () => {
    const input = makeInput([
      {
        id: 'e1',
        effectiveDate: new Date('2026-07-01T00:00:00Z'),
        category: 'growth',
        title: 'onboarding',
        description: null,
        consumptionDelta: 500,
        capacityDelta: null,
      },
    ]);
    const r = computeForecast(
      input,
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    );
    // May, Jun unaffected; Jul..Oct shifted by exactly +500 (no compounding)
    expect(r.months.map((m) => m.consumption)).toEqual([1000, 1000, 1500, 1500, 1500, 1500]);
  });

  it('stacks multiple events additively without re-applying earlier ones', () => {
    const input = makeInput([
      {
        id: 'e1',
        effectiveDate: new Date('2026-06-01T00:00:00Z'),
        category: 'growth',
        title: 'a',
        description: null,
        consumptionDelta: 200,
        capacityDelta: null,
      },
      {
        id: 'e2',
        effectiveDate: new Date('2026-08-01T00:00:00Z'),
        category: 'capacity',
        title: 'b',
        description: null,
        consumptionDelta: null,
        capacityDelta: 1000,
      },
    ]);
    const r = computeForecast(
      input,
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(r.months.map((m) => m.consumption)).toEqual([1000, 1200, 1200, 1200, 1200]);
    expect(r.months.map((m) => m.capacity)).toEqual([5000, 5000, 5000, 6000, 6000]);
  });

  it('applies a capacityDelta-only event to capacity and never to consumption', () => {
    const input = makeInput([
      {
        id: 'e1',
        effectiveDate: new Date('2026-07-01T00:00:00Z'),
        category: 'capacity',
        title: 'expansion',
        description: null,
        consumptionDelta: null,
        capacityDelta: 1000,
      },
    ]);
    const r = computeForecast(
      input,
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(r.months.map((m) => m.capacity)).toEqual([5000, 5000, 6000, 6000, 6000]);
    expect(r.months.map((m) => m.consumption)).toEqual([1000, 1000, 1000, 1000, 1000]);
  });

  it('keeps a pre-window event active in every month of the window', () => {
    const input = makeInput([
      {
        id: 'e1',
        effectiveDate: new Date('2026-01-01T00:00:00Z'),
        category: 'growth',
        title: 'old growth',
        description: null,
        consumptionDelta: 300,
        capacityDelta: null,
      },
    ]);
    const r = computeForecast(
      input,
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
    );
    expect(r.months.map((m) => m.consumption)).toEqual([1300, 1300, 1300]);
  });

  it('applies an event effective exactly at fromMonth, and ignores one after toMonth', () => {
    const input = makeInput([
      {
        id: 'e1',
        effectiveDate: new Date('2026-05-01T00:00:00Z'),
        category: 'growth',
        title: 'at start',
        description: null,
        consumptionDelta: 100,
        capacityDelta: null,
      },
      {
        id: 'e2',
        effectiveDate: new Date('2026-12-01T00:00:00Z'),
        category: 'growth',
        title: 'after end',
        description: null,
        consumptionDelta: 999,
        capacityDelta: null,
      },
    ]);
    const r = computeForecast(
      input,
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
    );
    expect(r.months.map((m) => m.consumption)).toEqual([1100, 1100, 1100]);
  });
});

/**
 * The absorption rule (#177, epic #172).
 *
 * These describe the same cluster shape and disagree on purpose. A baseline that
 * was MEASURED contains the deltas dated at or before the measurement; one that
 * was never measured is an admin's "everything not modelled elsewhere" and
 * contains none of them. The two meanings are genuinely different — not one a
 * special case of the other.
 *
 * The rule is keyed on the measured period ALONE. It used to consult `source` as
 * well, which was a defect: `source` flips to `manual` on any value correction, so
 * a 1% consumption fix on a synced cluster switched absorption off wholesale.
 * "Was it measured, and when" is the only fact no edit path can rewrite.
 */
describe('computeForecast — delta absorption depends on whether the baseline was measured', () => {
  const preBaselineEvent: ForecastInput['events'] = [
    {
      id: 'e-old',
      effectiveDate: new Date('2026-01-01T00:00:00Z'),
      category: 'growth',
      title: 'rollout completed before the baseline was taken',
      description: null,
      consumptionDelta: 300,
      capacityDelta: null,
    },
  ];

  /**
   * A synced baseline in the shape production can actually produce.
   *
   * `VsphereSnapshotService` is the sole writer of `captured_at`/`observed_at` and
   * derives them from one `measuredAt`, so every real `vsphere` row carries a
   * measured period and `baselineMeasuredAt` equals `baselineDate` on every row no
   * edit has re-dated. A fixture omitting it describes a row whose
   * `source='vsphere' => observed_at NOT NULL` invariant is broken, which
   * `absorbed` fails safe on by absorbing NOTHING — so it would quietly exercise
   * the null guard instead of the absorption rule these tests exist to pin. That
   * guard has its own test at the end of this block.
   */
  const measured = (events: ForecastInput['events']): ForecastInput => ({
    ...makeInput(events),
    baselineMeasuredAt: new Date('2026-05-01T00:00:00Z'),
  });

  it('unmeasured baseline: a pre-baseline delta is ADDED (the baseline excludes tracked entities)', () => {
    // What a genuinely manual row looks like on this interface: no measured
    // period, because no manual write path sets `observedAt`.
    const r = computeForecast(
      { ...makeInput(preBaselineEvent), baselineMeasuredAt: null },
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
    );
    // The admin entered 1000 as "everything not modelled elsewhere", so the
    // January rollout is genuinely on top of it.
    expect(r.months.map((m) => m.consumption)).toEqual([1300, 1300, 1300]);
  });

  it('measured baseline: a pre-baseline delta is ABSORBED (the snapshot already measured it)', () => {
    const r = computeForecast(
      measured(preBaselineEvent),
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
    );
    // The May snapshot measured actual usage, which already contains January's
    // rollout. Adding it again would report 1300 where the fleet uses 1000 —
    // consumption the hardware never sees, on the number that buys hardware.
    expect(r.months.map((m) => m.consumption)).toEqual([1000, 1000, 1000]);
  });

  it('measured baseline: a POST-baseline delta still applies — only absorption is filtered', () => {
    const r = computeForecast(
      measured([{ ...preBaselineEvent[0]!, effectiveDate: new Date('2026-06-01T00:00:00Z') }]),
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
    );
    // June is after the May capture, so it is a genuine projection, not a memory.
    expect(r.months.map((m) => m.consumption)).toEqual([1000, 1300, 1300]);
  });

  it('omitting the measured period absorbs nothing (every existing caller)', () => {
    const r = computeForecast(
      makeInput(preBaselineEvent),
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
    );
    expect(r.months.map((m) => m.consumption)).toEqual([1300, 1300, 1300]);
  });

  const capacityBeforeBaseline: ForecastInput['events'] = [
    {
      id: 'e-cap',
      effectiveDate: new Date('2026-03-01T00:00:00Z'),
      category: 'hardware',
      title: 'memory installed before the baseline',
      description: null,
      consumptionDelta: null,
      capacityDelta: 2560,
    },
  ];

  it('a measured baseline absorbs a capacityDelta too, not just consumption', () => {
    const r = computeForecast(
      measured(capacityBeforeBaseline),
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
    );
    // The synced host capacity already carries the installed memory. Adding the
    // event's delta on top would invent 2560 GiB that does not exist — and
    // overstated capacity is what stops hardware being ordered.
    expect(r.months.map((m) => m.capacity)).toEqual([5000, 5000]);
  });

  it('a baseline with NO measured period absorbs NOTHING, capacityDelta included', () => {
    // The broken-invariant guard, pinned deliberately because nothing in the
    // schema enforces `source='vsphere' => observed_at NOT NULL` — there is no
    // CHECK constraint, and the Guard-1 runbook in docs/operations.md tells
    // operators to re-run the expand `INSERT ... SELECT` by hand.
    //
    // The tempting reading is "fall back to `baselineDate`". That is exactly the
    // operator-editable label `absorbed` was just taken OFF, so falling back
    // reinstates the defect the moment the invariant breaks.
    //
    // This assertion is also the counter-example to the claim that absorbing
    // nothing is safe in BOTH delta fields at once. It is not, and the retired
    // argument for it (`VsphereSnapshotService` writes `baselineCapacity: 0`) was
    // a non-sequitur: `baselineCapacity` is a scalar term and `capacityDelta` is
    // an event term, and zeroing one says nothing about the other. Counting the
    // March capacityDelta reads 7560 rather than 5000 — capacity OVERSTATED,
    // utilization lower, hardware DEFERRED. That is the unsafe direction, asserted
    // rather than argued away; the branch is acceptable only because it is
    // unreachable while the invariant holds.
    const r = computeForecast(
      { ...makeInput(capacityBeforeBaseline) },
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
    );
    expect(r.months.map((m) => m.capacity)).toEqual([7560, 7560]);

    // And explicitly NOT the `baselineDate` fallback, which would have absorbed
    // the March delta exactly as the sibling test above does.
    expect(r.months.map((m) => m.capacity)).not.toEqual([5000, 5000]);
  });
});
