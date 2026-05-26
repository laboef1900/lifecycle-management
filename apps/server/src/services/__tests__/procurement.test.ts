import { describe, expect, it } from 'vitest';

import type { MonthlyPoint } from '../forecast.js';
import { computeProcurementInfo } from '../procurement.js';

function makeMonths(specs: Array<[string, number]>): MonthlyPoint[] {
  // Each spec is [month, utilization]. Capacity/consumption are derived so the
  // helper sees the intended utilization regardless of magnitude.
  return specs.map(([month, util]) => ({
    month,
    capacity: 1000,
    consumption: util * 1000,
    utilization: util,
  }));
}

describe('computeProcurementInfo', () => {
  it('returns null orderByDate/breachMonth when no month breaches warn', () => {
    const months = makeMonths([
      ['2026-05-01', 0.4],
      ['2026-06-01', 0.5],
      ['2026-07-01', 0.65],
    ]);
    const r = computeProcurementInfo({ months, warnFraction: 0.7, leadTimeWeeks: 8 });
    expect(r).toEqual({ leadTimeWeeks: 8, orderByDate: null, breachMonth: null });
  });

  it('finds the first breaching month and subtracts lead time', () => {
    const months = makeMonths([
      ['2026-05-01', 0.4],
      ['2026-06-01', 0.6],
      ['2026-07-01', 0.72],
      ['2026-08-01', 0.85],
    ]);
    const r = computeProcurementInfo({ months, warnFraction: 0.7, leadTimeWeeks: 8 });
    // 2026-07-01 minus 8 weeks (56 days) = 2026-05-06
    expect(r).toEqual({ leadTimeWeeks: 8, orderByDate: '2026-05-06', breachMonth: '2026-07-01' });
  });

  it('returns an overdue date when lead time exceeds runway (no clamping)', () => {
    const months = makeMonths([
      ['2026-05-01', 0.75],
      ['2026-06-01', 0.8],
    ]);
    // 8 weeks before May 1 = March 6 — already past. Helper must NOT clamp.
    const r = computeProcurementInfo({ months, warnFraction: 0.7, leadTimeWeeks: 8 });
    expect(r.orderByDate).toBe('2026-03-06');
    expect(r.breachMonth).toBe('2026-05-01');
  });

  it('with leadTimeWeeks === 0 the order-by date equals the breach month start', () => {
    const months = makeMonths([
      ['2026-05-01', 0.5],
      ['2026-06-01', 0.71],
    ]);
    const r = computeProcurementInfo({ months, warnFraction: 0.7, leadTimeWeeks: 0 });
    expect(r).toEqual({ leadTimeWeeks: 0, orderByDate: '2026-06-01', breachMonth: '2026-06-01' });
  });

  it('boundary: breach exactly at warn threshold (>= not >)', () => {
    const months = makeMonths([
      ['2026-05-01', 0.69999],
      ['2026-06-01', 0.7],
    ]);
    const r = computeProcurementInfo({ months, warnFraction: 0.7, leadTimeWeeks: 1 });
    expect(r.breachMonth).toBe('2026-06-01');
    // 2026-06-01 minus 7 days = 2026-05-25
    expect(r.orderByDate).toBe('2026-05-25');
  });

  it('ignores months with zero capacity (avoids divide-by-zero false positives)', () => {
    const months: MonthlyPoint[] = [
      { month: '2026-05-01', capacity: 0, consumption: 0, utilization: 0 },
      { month: '2026-06-01', capacity: 1000, consumption: 800, utilization: 0.8 },
    ];
    const r = computeProcurementInfo({ months, warnFraction: 0.7, leadTimeWeeks: 4 });
    expect(r.breachMonth).toBe('2026-06-01');
  });

  it('uses the effective warn (caller-supplied) — not a system default', () => {
    const months = makeMonths([
      ['2026-05-01', 0.5],
      ['2026-06-01', 0.55],
    ]);
    // Cluster override sets warn at 0.5 — June would be a breach under that.
    const r = computeProcurementInfo({ months, warnFraction: 0.5, leadTimeWeeks: 0 });
    expect(r.breachMonth).toBe('2026-05-01');
  });

  it('empty months array returns no breach', () => {
    const r = computeProcurementInfo({ months: [], warnFraction: 0.7, leadTimeWeeks: 8 });
    expect(r).toEqual({ leadTimeWeeks: 8, orderByDate: null, breachMonth: null });
  });
});
