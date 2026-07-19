import { describe, expect, it } from 'vitest';

import { formatGb, formatNumber, formatRunway, RUNWAY_UNIT } from './format';

describe('formatGb', () => {
  it('rounds and formats with thousands separators', () => {
    expect(formatGb(1234.6)).toBe('1,235 GB');
  });
});

describe('formatNumber', () => {
  it('rounds and formats with thousands separators', () => {
    expect(formatNumber(1234.4)).toBe('1,234');
  });
});

describe('formatRunway (#243 Part B copy item 2 — the shared runway-unit formatter)', () => {
  it('renders a bounded countdown as "N mo"', () => {
    expect(formatRunway(9)).toBe('9 mo');
  });

  it('renders an open-ended countdown as "N+ mo"', () => {
    expect(formatRunway(24, true)).toBe('24+ mo');
  });

  it('uses the lowercase unit every consumer should share', () => {
    // Pinned so the tile numeral (previously the one outlier at 'MO'),
    // RunwayPill, and the fleet verdict headline can never drift apart again.
    expect(RUNWAY_UNIT).toBe('mo');
    expect(formatRunway(1)).toContain(RUNWAY_UNIT);
  });
});
