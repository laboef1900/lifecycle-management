import type { ForecastUncertaintyBandWidth } from '@lcm/shared';

/**
 * Empirical forecast-error band (docs/design/forecast-uncertainty-band.md).
 *
 * Pure, deterministic, no I/O — the band is derived ONLY from measured past
 * forecast error (never fabricated). Owner-confirmed methodology (2026-07-24):
 * bias-corrected, per-horizon with a global floor, on utilization fraction.
 */

/**
 * One matured past forecast-vs-actual observation. Both are utilization
 * FRACTIONS (0..1), matching `ForecastMonthPoint.utilization` and the stored
 * `projectedUtil` — the math is unit-agnostic, but every runtime value here is a
 * fraction, never a percentage.
 */
export interface ForecastErrorSample {
  /** Months ahead the projection was made for (1 = the month after the anchor). */
  horizonIndex: number;
  /** Projected utilization fraction at that horizon. */
  projected: number;
  /** Utilization fraction that actually occurred at that month. */
  actual: number;
}

/** Low/high band offsets (utilization fraction) to add to a current projection. */
export interface ErrorBand {
  low: number;
  high: number;
}

/**
 * Per-horizon minimum matured samples before that horizon shows a band. Small,
 * fixed floor for a meaningful spread; the GLOBAL gate is the tenant's
 * configurable `minAnchors`.
 */
export const PER_HORIZON_MIN_SAMPLES = 3;

const QUANTILES: Record<
  Exclude<ForecastUncertaintyBandWidth, 'stddev'>,
  { low: number; high: number }
> = {
  p10_p90: { low: 0.1, high: 0.9 },
  p05_p95: { low: 0.05, high: 0.95 },
};

/** Linear-interpolated quantile of an ascending-sorted array (0 ≤ q ≤ 1). */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1); 0 for fewer than two samples. */
function stddev(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Per-horizon band OFFSETS (utilization fraction) to add to a current projection P
 * so the band shows the ACTUAL's likely range: `[P + low, P + high]`.
 *
 * `error = projected - actual`, so `actual ≈ projected - error`:
 *  - **percentile** widths (p10_p90 / p05_p95): `[-quantile(error, high), -quantile(error, low)]`
 *    — inherently **bias-inclusive** (asymmetric around 0 when the forecast is biased);
 *  - **stddev**: **bias-corrected** ±1σ → `[-mean - σ, -mean + σ]`.
 *
 * Gating: a GLOBAL floor (`anchorCount >= minAnchors` before ANY band), then
 * PER-HORIZON (each horizon needs `>= PER_HORIZON_MIN_SAMPLES` matured samples),
 * so a near-term band can appear before a long-horizon one. Empty map when the
 * global floor is unmet — an honest absence, never a fabricated zero-width band.
 */
export function computeForecastErrorBands(
  samples: readonly ForecastErrorSample[],
  anchorCount: number,
  bandWidth: ForecastUncertaintyBandWidth,
  minAnchors: number,
): Map<number, ErrorBand> {
  const bands = new Map<number, ErrorBand>();
  if (anchorCount < minAnchors) return bands;

  const byHorizon = new Map<number, number[]>();
  for (const s of samples) {
    const err = s.projected - s.actual;
    const arr = byHorizon.get(s.horizonIndex);
    if (arr) arr.push(err);
    else byHorizon.set(s.horizonIndex, [err]);
  }

  for (const [horizon, errors] of byHorizon) {
    if (errors.length < PER_HORIZON_MIN_SAMPLES) continue;
    if (bandWidth === 'stddev') {
      const m = mean(errors);
      const sd = stddev(errors, m);
      bands.set(horizon, { low: -m - sd, high: -m + sd });
    } else {
      const q = QUANTILES[bandWidth];
      const sorted = [...errors].sort((a, b) => a - b);
      bands.set(horizon, { low: -quantile(sorted, q.high), high: -quantile(sorted, q.low) });
    }
  }
  return bands;
}
