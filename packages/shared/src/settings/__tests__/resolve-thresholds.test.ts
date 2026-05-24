import { describe, expect, it } from 'vitest';

import { resolveThresholds, SYSTEM_DEFAULTS } from '../resolve-thresholds.js';

describe('SYSTEM_DEFAULTS', () => {
  it('is 0.7 / 0.9', () => {
    expect(SYSTEM_DEFAULTS).toEqual({ warn: 0.7, crit: 0.9 });
  });
});

describe('resolveThresholds', () => {
  it('falls back to SYSTEM_DEFAULTS when both inputs are null', () => {
    expect(resolveThresholds(null, null)).toEqual({ warn: 0.7, crit: 0.9 });
  });

  it('uses tenant values when cluster is null', () => {
    expect(resolveThresholds(null, { warnThreshold: 0.6, critThreshold: 0.8 })).toEqual({
      warn: 0.6,
      crit: 0.8,
    });
  });

  it('uses cluster values when both levels are set', () => {
    expect(
      resolveThresholds(
        { warnThreshold: 0.5, critThreshold: 0.85 },
        { warnThreshold: 0.6, critThreshold: 0.8 },
      ),
    ).toEqual({ warn: 0.5, crit: 0.85 });
  });

  it('inherits per-field when only one cluster value is set', () => {
    expect(
      resolveThresholds(
        { warnThreshold: 0.5, critThreshold: null },
        { warnThreshold: 0.6, critThreshold: 0.85 },
      ),
    ).toEqual({ warn: 0.5, crit: 0.85 });
  });

  it('inherits from tenant when cluster crit is null and warn is overridden', () => {
    expect(
      resolveThresholds(
        { warnThreshold: 0.5, critThreshold: null },
        { warnThreshold: 0.6, critThreshold: 0.85 },
      ),
    ).toEqual({ warn: 0.5, crit: 0.85 });
  });

  it('accepts custom defaults', () => {
    expect(resolveThresholds(null, null, { warn: 0.5, crit: 0.75 })).toEqual({
      warn: 0.5,
      crit: 0.75,
    });
  });
});
