import { describe, expect, it } from 'vitest';

import { autoScaleDomain, niceNumber } from './chart-scale';

describe('niceNumber', () => {
  it('rounds UP to the next nice fraction when round is false', () => {
    expect(niceNumber(1.1, false)).toBe(2);
    expect(niceNumber(2.1, false)).toBe(5);
    expect(niceNumber(5.1, false)).toBe(10);
  });

  it('picks the NEAREST nice fraction when round is true', () => {
    expect(niceNumber(1.4, true)).toBe(1);
    expect(niceNumber(1.6, true)).toBe(2);
    expect(niceNumber(6, true)).toBe(5);
  });

  it('returns 0 for non-positive input rather than NaN from log10', () => {
    expect(niceNumber(0, true)).toBe(0);
    expect(niceNumber(-5, true)).toBe(0);
  });
});

describe('autoScaleDomain', () => {
  it('centres the data in the returned window', () => {
    // The centring is the entire point of the per-tile scale (#268) — if this
    // regresses, the consumption line drifts off the middle of every tile.
    const { min, max } = autoScaleDomain([70, 80, 92, 100]);
    expect((min + max) / 2).toBeCloseTo(85, 6);
    expect(min).toBeLessThan(70);
    expect(max).toBeGreaterThan(100);
  });

  it('leaves symmetric padding, so the line never touches the plot edges', () => {
    const { min, max } = autoScaleDomain([60, 80]);
    expect(60 - min).toBeCloseTo(max - 80, 6);
    expect(min).toBeLessThan(60);
  });

  it('widens a flat series to minSpan instead of collapsing to zero height', () => {
    const { min, max } = autoScaleDomain([55, 55, 55]);
    expect(max - min).toBeGreaterThanOrEqual(12);
    expect((min + max) / 2).toBeCloseTo(55, 6);
  });

  it('pins to the floor rather than returning a negative domain', () => {
    const { min, max } = autoScaleDomain([0, 0]);
    expect(min).toBe(0);
    // The span survives the pin — the plot still fills vertically, it just
    // stops being centred (unavoidable at 0).
    expect(max).toBeGreaterThanOrEqual(12);
  });

  it('keeps a near-floor series inside the window without going negative', () => {
    const { min, max } = autoScaleDomain([1, 3]);
    expect(min).toBe(0);
    expect(max).toBeGreaterThanOrEqual(3);
  });

  it('returns ticks that all fall inside the domain', () => {
    for (const values of [
      [70, 100],
      [12, 13],
      [0, 0],
      [130, 160],
      [4, 97],
    ]) {
      const { min, max, ticks } = autoScaleDomain(values);
      expect(ticks.length).toBeGreaterThan(0);
      for (const t of ticks) {
        expect(t).toBeGreaterThanOrEqual(min);
        expect(t).toBeLessThanOrEqual(max);
      }
    }
  });

  it('returns round tick values, free of binary-float dust', () => {
    const { ticks } = autoScaleDomain([70, 80, 92, 100]);
    expect(ticks).toEqual([70, 80, 90, 100]);
  });

  it('ignores non-finite values rather than poisoning the domain with NaN', () => {
    const { min, max } = autoScaleDomain([70, Number.NaN, 100, Number.POSITIVE_INFINITY]);
    expect(Number.isFinite(min)).toBe(true);
    expect(Number.isFinite(max)).toBe(true);
    expect((min + max) / 2).toBeCloseTo(85, 6);
  });

  it('falls back to a usable window for an empty series', () => {
    const { min, max, ticks } = autoScaleDomain([]);
    expect(min).toBe(0);
    expect(max).toBeGreaterThan(0);
    expect(ticks.length).toBeGreaterThan(0);
  });
});
