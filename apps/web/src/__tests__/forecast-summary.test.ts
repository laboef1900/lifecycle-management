import type { ForecastMonthPoint } from '@lcm/shared';
import { describe, expect, it } from 'vitest';

import { fleetRunwayToWarn, runwayToWarn } from '../lib/forecast-summary';

const point = (month: string, consumption: number, capacity: number): ForecastMonthPoint => ({
  month,
  consumption,
  capacity,
  utilization: capacity > 0 ? consumption / capacity : 0,
});

describe('runwayToWarn', () => {
  it('returns null months + no breach when forecast stays below 70%', () => {
    const months = [point('2026-05-01', 100, 1000), point('2026-06-01', 200, 1000)];
    expect(runwayToWarn(months)).toEqual({ months: null, alreadyBreached: false });
  });

  it('returns the index of the first month that crosses 70%', () => {
    const months = [
      point('2026-05-01', 500, 1000), // 50%
      point('2026-06-01', 600, 1000), // 60%
      point('2026-07-01', 720, 1000), // 72%
      point('2026-08-01', 800, 1000), // 80%
    ];
    expect(runwayToWarn(months)).toEqual({ months: 2, alreadyBreached: false });
  });

  it('reports already-breached warn when first month is >= 70%', () => {
    const months = [point('2026-05-01', 750, 1000), point('2026-06-01', 800, 1000)];
    expect(runwayToWarn(months)).toEqual({ months: 0, alreadyBreached: 'warn' });
  });

  it('reports already-breached crit when first month is >= 90%', () => {
    const months = [point('2026-05-01', 950, 1000)];
    expect(runwayToWarn(months)).toEqual({ months: 0, alreadyBreached: 'crit' });
  });

  it('treats zero-capacity months as null and skips them when scanning', () => {
    const months = [
      point('2026-05-01', 0, 0),
      point('2026-06-01', 800, 1000), // 80%, the first non-zero month breaches
    ];
    expect(runwayToWarn(months)).toEqual({ months: 1, alreadyBreached: false });
  });

  it('returns null months + no breach for an empty forecast', () => {
    expect(runwayToWarn([])).toEqual({ months: null, alreadyBreached: false });
  });
});

describe('fleetRunwayToWarn', () => {
  it('aggregates consumption + capacity across series before scanning', () => {
    const a = [point('2026-05-01', 300, 1000), point('2026-06-01', 400, 1000)]; // 30%, 40%
    const b = [point('2026-05-01', 400, 1000), point('2026-06-01', 400, 1000)]; // 40%, 40%
    // Fleet: 700/2000=35%, 800/2000=40% — no breach
    expect(fleetRunwayToWarn([a, b])).toEqual({ months: null, alreadyBreached: false });
  });

  it('detects fleet breach even when individual clusters stay below 70%', () => {
    const a = [point('2026-05-01', 650, 1000)]; // 65%
    const b = [point('2026-05-01', 700, 1000)]; // 70% (warn)
    // Fleet: 1350/2000 = 67.5% — still ok
    expect(fleetRunwayToWarn([a, b])).toEqual({ months: null, alreadyBreached: false });
    const c = [point('2026-05-01', 800, 1000)]; // 80%
    // Fleet a+c: 1450/2000 = 72.5% — breach in month 0
    expect(fleetRunwayToWarn([a, c])).toEqual({ months: 0, alreadyBreached: 'warn' });
  });

  it('returns null for empty input', () => {
    expect(fleetRunwayToWarn([])).toEqual({ months: null, alreadyBreached: false });
  });
});
