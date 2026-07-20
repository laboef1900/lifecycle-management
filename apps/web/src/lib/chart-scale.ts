/**
 * Y-axis scale math shared by the chart components.
 *
 * `niceNumber` is the classic Heckbert graph-labeling primitive, previously
 * private to `forecast-chart.tsx`; `autoScaleDomain` builds on it for the
 * fleet tile chart's per-tile window (#268).
 */

/**
 * A "nice" round number near `value`: `round` picks the nearest nice fraction
 * (for a tick step); unset rounds UP to the next nice fraction (for a
 * headroom-safe range).
 */
export function niceNumber(value: number, round: boolean): number {
  if (value <= 0) return 0;
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  let niceFraction: number;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else {
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
  }
  return niceFraction * 10 ** exponent;
}

export interface AutoScale {
  /** Domain floor, in the same unit as the input values. */
  min: number;
  /** Domain ceiling. */
  max: number;
  /** Nice round tick values falling inside `[min, max]`. */
  ticks: number[];
}

export interface AutoScaleOptions {
  /**
   * Smallest domain span to render. A cluster whose utilization barely moves
   * across the window would otherwise collapse the domain to (near) zero
   * height, turning millivolt-scale noise into a dramatic-looking climb.
   */
  minSpan?: number;
  /** Symmetric breathing room above and below the data, as a fraction of its span. */
  padRatio?: number;
  /** Hard domain floor — utilization is never negative, so a sub-zero axis is nonsense. */
  floor?: number;
  /** Approximate number of ticks to aim for; the nice-step search decides the real count. */
  targetTicks?: number;
}

const DEFAULTS = { minSpan: 12, padRatio: 0.18, floor: 0, targetTicks: 3 } as const;

/** Trim binary-float dust so a tick reads `70`, never `69.99999999999999`. */
const tidy = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * A y-domain fitted to `values`, centred on them, with nice round ticks.
 *
 * Used by the fleet tile chart (#268) to give each tile its own scale so the
 * consumption line is vertically centred and uses the chart's full height.
 * This deliberately replaced a fixed window shared across every tile — see the
 * 2026-07-20 amendment to spec §4.4 for the comparability trade-off that was
 * accepted, and note the consequence encoded here: because the returned ticks
 * are now the reader's ONLY cue to where on the scale a tile sits, they must
 * always be rendered.
 *
 * Centring is symmetric except at the floor: a series sitting at or near 0 %
 * cannot be centred without showing negative percentages, so the domain pins
 * to `floor` and the line rides the bottom. That is the honest rendering, not
 * a bug.
 */
export function autoScaleDomain(values: number[], options: AutoScaleOptions = {}): AutoScale {
  const minSpan = options.minSpan ?? DEFAULTS.minSpan;
  const padRatio = options.padRatio ?? DEFAULTS.padRatio;
  const floor = options.floor ?? DEFAULTS.floor;
  const targetTicks = options.targetTicks ?? DEFAULTS.targetTicks;

  const finite = values.filter((v) => Number.isFinite(v));
  const dataMin = finite.length > 0 ? Math.min(...finite) : floor;
  const dataMax = finite.length > 0 ? Math.max(...finite) : floor + minSpan;

  const mid = (dataMin + dataMax) / 2;
  // Half-span, widened to `minSpan` for a flat series so the line lands
  // mid-box rather than on a zero-height domain.
  const half = Math.max((dataMax - dataMin) / 2, minSpan / 2);
  const pad = half * 2 * padRatio;

  let min = mid - half - pad;
  let max = mid + half + pad;

  // Pin to the floor ONLY when the data itself respects it. A series that
  // genuinely dips below `floor` must stay inside the window: pinning above it
  // would put real points outside the domain, where the caller's
  // `allowDataOverflow` clips them away silently, with no marker and no clue
  // that anything is missing. Showing the negative range is the honest
  // rendering of negative data.
  if (min < floor && dataMin >= floor) {
    min = floor;
    // Preserve the intended span rather than squashing the plot against the
    // floor — the line stops being centred (unavoidable at 0) but still fills
    // the box vertically.
    max = Math.max(max, floor + minSpan);
  }

  const step = niceNumber((max - min) / targetTicks, true);
  const ticks: number[] = [];
  if (step > 0) {
    const first = Math.ceil(min / step) * step;
    // Index the loop instead of accumulating `v += step`, so float drift can't
    // push the last tick just past `max` and drop it.
    for (let i = 0; first + i * step <= max + step * 1e-9; i += 1) {
      ticks.push(tidy(first + i * step));
    }
  }

  return { min: tidy(min), max: tidy(max), ticks };
}
