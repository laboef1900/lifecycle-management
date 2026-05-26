import { describe, expect, it } from 'vitest';

import { tileYDomain } from './fleet-cluster-tile-chart';

describe('tileYDomain', () => {
  it('falls back to [0, 1] for an empty series so the chart still renders', () => {
    expect(tileYDomain([], { warn: 0.7, crit: 0.9 })).toEqual({
      domain: [0, 1],
      ticks: [0, 1],
    });
  });

  it('zooms tightly around the data + thresholds, snapping to 5% intervals', () => {
    // Real scenario: data 0.382, warn 0.43, crit 0.48.
    // lo = 0.382, hi = 0.48
    // yMin = floor(7.64)/20 - 0.05 = 0.35 - 0.05 = 0.30
    // yMax = ceil(9.6)/20 + 0.05 = 0.50 + 0.05 = 0.55
    expect(tileYDomain([0.382, 0.382, 0.382], { warn: 0.43, crit: 0.48 })).toEqual({
      domain: [0.3, 0.55],
      ticks: [0.3, 0.55],
    });
  });

  it('always includes the warn threshold in the range, even if data is well below', () => {
    // Data well below warn: lo should be clamped to warn (so the warn band stays visible)
    const result = tileYDomain([0.1, 0.15], { warn: 0.7, crit: 0.9 });
    expect(result.domain[0]).toBeLessThanOrEqual(0.7);
    expect(result.domain[1]).toBeGreaterThanOrEqual(0.9);
  });

  it('always includes the crit threshold in the range, even if data is well above', () => {
    // Data already past crit: hi should still include crit
    const result = tileYDomain([0.95, 0.99], { warn: 0.7, crit: 0.9 });
    expect(result.domain[0]).toBeLessThanOrEqual(0.7);
    expect(result.domain[1]).toBeGreaterThanOrEqual(0.95);
  });

  it('clamps to [0, 1]', () => {
    // Tiny data, low thresholds — yMin can't go negative
    const lower = tileYDomain([0.01], { warn: 0.02, crit: 0.03 });
    expect(lower.domain[0]).toBe(0);
    // Data and thresholds near 1 — yMax can't exceed 1
    const upper = tileYDomain([1, 0.99], { warn: 0.95, crit: 0.98 });
    expect(upper.domain[1]).toBe(1);
  });

  it('returns ticks equal to the domain extremes (so labels mark top and bottom only)', () => {
    const r = tileYDomain([0.5], { warn: 0.7, crit: 0.9 });
    expect(r.ticks).toEqual([r.domain[0], r.domain[1]]);
  });

  it('guarantees at least a 10% visible range so the line never collapses', () => {
    // Single data point at exactly the threshold
    const r = tileYDomain([0.7], { warn: 0.7, crit: 0.9 });
    expect(r.domain[1] - r.domain[0]).toBeGreaterThanOrEqual(0.1);
  });
});
