import { describe, expect, it } from 'vitest';

import {
  computeForecastErrorBands,
  PER_HORIZON_MIN_SAMPLES,
  type ForecastErrorSample,
} from '../services/forecast-error.js';

/** Build N samples at one horizon, each with the given (projected - actual) error. */
function samplesWithErrors(horizonIndex: number, errors: number[]): ForecastErrorSample[] {
  return errors.map((e) => ({ horizonIndex, projected: 50 + e, actual: 50 }));
}

const K = 6;

describe('computeForecastErrorBands', () => {
  it('returns an empty map below the global anchor floor', () => {
    const samples = samplesWithErrors(1, [1, 2, 3, 4, 5]);
    // 5 anchors < K=6: no band at all, even with plenty of samples.
    expect(computeForecastErrorBands(samples, 5, 'p10_p90', K).size).toBe(0);
  });

  it('excludes a horizon with fewer than the per-horizon minimum samples', () => {
    expect(PER_HORIZON_MIN_SAMPLES).toBe(3);
    const samples = [...samplesWithErrors(1, [1, 2, 3]), ...samplesWithErrors(2, [1, 2])];
    const bands = computeForecastErrorBands(samples, K, 'p10_p90', K);
    expect(bands.has(1)).toBe(true); // 3 samples → included
    expect(bands.has(2)).toBe(false); // 2 samples → excluded (near-term appears before long-term)
  });

  it('collapses to a single bias point when every error is identical', () => {
    // Forecast always 5 pts too high → actual ≈ projected − 5, no spread.
    const bands = computeForecastErrorBands(samplesWithErrors(1, [5, 5, 5]), K, 'p10_p90', K);
    const b = bands.get(1)!;
    expect(b.low).toBeCloseTo(-5, 6);
    expect(b.high).toBeCloseTo(-5, 6);
  });

  it('is symmetric around the projection for unbiased errors', () => {
    const bands = computeForecastErrorBands(samplesWithErrors(1, [-6, 0, 6]), K, 'p10_p90', K);
    const b = bands.get(1)!;
    // p10/p90 of [-6,0,6] are ±4.8; offsets are [-p90, -p10] = [-4.8, +4.8].
    expect(b.low).toBeCloseTo(-4.8, 6);
    expect(b.high).toBeCloseTo(4.8, 6);
  });

  it('places the band below the projection when the forecast is biased high (sign convention)', () => {
    // Consistently over-forecasting → actual sits below the projected line.
    const bands = computeForecastErrorBands(samplesWithErrors(1, [3, 4, 5]), K, 'p10_p90', K);
    const b = bands.get(1)!;
    expect(b.low).toBeLessThan(0);
    expect(b.high).toBeLessThan(0);
    // percentile band is inherently bias-inclusive: [-p90, -p10] of [3,4,5].
    expect(b.low).toBeCloseTo(-4.8, 6);
    expect(b.high).toBeCloseTo(-3.2, 6);
  });

  it('bias-corrects the stddev band by the mean error', () => {
    // errors [3,4,5]: mean 4, sample sd 1 → offsets [-mean-σ, -mean+σ] = [-5, -3].
    const bands = computeForecastErrorBands(samplesWithErrors(1, [3, 4, 5]), K, 'stddev', K);
    const b = bands.get(1)!;
    expect(b.low).toBeCloseTo(-5, 6);
    expect(b.high).toBeCloseTo(-3, 6);
  });

  it('makes p05_p95 wider than p10_p90 on the same data', () => {
    const errors = [-10, -3, 0, 4, 12, -1, 6];
    const inner = computeForecastErrorBands(samplesWithErrors(1, errors), K, 'p10_p90', K).get(1)!;
    const outer = computeForecastErrorBands(samplesWithErrors(1, errors), K, 'p05_p95', K).get(1)!;
    expect(outer.high - outer.low).toBeGreaterThan(inner.high - inner.low);
  });

  it('computes each horizon independently from its own matured samples', () => {
    const samples = [...samplesWithErrors(1, [1, 1, 1]), ...samplesWithErrors(3, [10, 10, 10])];
    const bands = computeForecastErrorBands(samples, K, 'p10_p90', K);
    expect(bands.get(1)!.low).toBeCloseTo(-1, 6);
    expect(bands.get(3)!.low).toBeCloseTo(-10, 6);
  });

  it('reports each horizon its OWN sample count, not the global anchor count (#317)', () => {
    // The whole point of the field: 9 anchors in the pool, but horizon 5 was
    // measured only 3 times. Quoting 9 against horizon 5 overstates its evidence.
    const samples = [
      ...samplesWithErrors(1, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      ...samplesWithErrors(5, [1, 2, 3]),
    ];
    const bands = computeForecastErrorBands(samples, 9, 'p10_p90', K);
    expect(bands.get(1)!.sampleCount).toBe(9);
    expect(bands.get(5)!.sampleCount).toBe(3);
  });

  it('counts samples identically for the stddev width', () => {
    // The count is evidence, not a property of the quantile maths — it must not
    // depend on which band width the tenant configured.
    const samples = samplesWithErrors(2, [3, 4, 5, 6]);
    expect(computeForecastErrorBands(samples, K, 'stddev', K).get(2)!.sampleCount).toBe(4);
    expect(computeForecastErrorBands(samples, K, 'p05_p95', K).get(2)!.sampleCount).toBe(4);
  });

  it('never emits a count below the per-horizon floor', () => {
    // A thin horizon is omitted entirely rather than emitted with a small count,
    // so any count a caller can read is >= PER_HORIZON_MIN_SAMPLES.
    const samples = [
      ...samplesWithErrors(1, [1, 2, 3]),
      ...samplesWithErrors(2, [1, 2]), // below the floor
    ];
    const bands = computeForecastErrorBands(samples, K, 'p10_p90', K);
    for (const band of bands.values()) {
      expect(band.sampleCount).toBeGreaterThanOrEqual(PER_HORIZON_MIN_SAMPLES);
    }
    expect(bands.has(2)).toBe(false);
  });
});
