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
});
