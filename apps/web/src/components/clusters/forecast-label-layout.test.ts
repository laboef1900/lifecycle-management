import { describe, expect, it } from 'vitest';

import {
  CHART_HEIGHT,
  CHART_MARGIN,
  X_AXIS_HEIGHT,
  eventLabelBoxSize,
  layoutEventLabel,
  planEventLabelOffsets,
  truncateEventTitle,
} from './forecast-label-layout';

// Derived from the module's sizing constants (fontSize 10/9, padding 4/5):
// non-compact boxes are 20px wide, compact 19px; narrow glyphs measure 0.6em.
const BOX_WIDTH = 20;
const BOX_WIDTH_COMPACT = 19;
// The vertical band labels must stay inside (between the chart's top margin
// and the x-axis).
const PLOT_TOP = CHART_MARGIN.top;
const PLOT_BOTTOM = CHART_HEIGHT - CHART_MARGIN.bottom - X_AXIS_HEIGHT;

describe('truncateEventTitle', () => {
  it('returns short titles unchanged, trimmed', () => {
    expect(truncateEventTitle('  Wachstum  ', false)).toBe('Wachstum');
  });

  it('keeps a title exactly at the limit without an ellipsis', () => {
    expect(truncateEventTitle('abcdefghijklmnopqr', false)).toBe('abcdefghijklmnopqr');
  });

  it('truncates over-long titles to exactly 17 glyphs plus an ellipsis', () => {
    expect(truncateEventTitle('A very long event title that overflows the chart', false)).toBe(
      'A very long event…',
    );
  });

  it('trims trailing whitespace at the cut before appending the ellipsis', () => {
    expect(truncateEventTitle('Hardware refresh Q3 2027', false)).toBe('Hardware refresh…');
  });

  it('uses the tighter compact limit of 12 glyphs', () => {
    expect(truncateEventTitle('Kapazitätserweiterung', true)).toBe('Kapazitätse…');
  });

  it('never splits a surrogate pair at the cut point', () => {
    // The rocket is the 18th glyph; a UTF-16 slice would cut it in half.
    expect(truncateEventTitle('0123456789abcdefg🚀xyz', false)).toBe('0123456789abcdefg…');
    // A kept astral glyph survives whole and, being wide, spends 1em of the
    // pixel budget (so one fewer narrow glyph fits after it).
    expect(truncateEventTitle('ab🚀cdefghijklmnopqrst', false)).toBe('ab🚀cdefghijklmno…');
  });

  it('truncates wide-glyph titles earlier so the box always fits the plot band', () => {
    // 18 CJK glyphs measure 180px, well over the 108px budget that 18 narrow
    // glyphs would occupy; only 10 wide glyphs (plus the ellipsis) fit.
    expect(truncateEventTitle('容量拡張計画容量拡張計画容量拡張計画', false)).toBe(
      '容量拡張計画容量拡張…',
    );
  });
});

describe('eventLabelBoxSize', () => {
  it('sizes Latin text at ~0.6em per glyph', () => {
    expect(eventLabelBoxSize('Wachstum', false)).toEqual({ width: BOX_WIDTH, height: 58 });
  });

  it('sizes East-Asian wide glyphs at ~1em each', () => {
    expect(eventLabelBoxSize('容量拡張計画', false)).toEqual({ width: BOX_WIDTH, height: 70 });
    expect(eventLabelBoxSize('DB移行', false)).toEqual({ width: BOX_WIDTH, height: 42 });
  });

  it('uses the smaller compact font metrics', () => {
    expect(eventLabelBoxSize('x', true)).toEqual({ width: BOX_WIDTH_COMPACT, height: 15 });
  });
});

describe('layoutEventLabel', () => {
  const opts = { title: 'Migration', compact: false, offsetX: 0 };

  it('returns null for a missing viewBox', () => {
    expect(layoutEventLabel(undefined, opts)).toBeNull();
  });

  it('returns null for a malformed viewBox', () => {
    expect(layoutEventLabel({}, opts)).toBeNull();
    expect(layoutEventLabel({ x: 'oops', y: 0, width: 10, height: 10 }, opts)).toBeNull();
  });

  it('places the box below the dot with the leader meeting the box top', () => {
    const geometry = layoutEventLabel({ x: 100, y: 100, width: 10, height: 10 }, opts);
    // 'Migration' is 9 glyphs -> 64px box; dot centre (105, 105), bottom 110.
    expect(geometry).toEqual({
      text: 'Migration',
      fontSize: 10,
      box: { x: 95, y: 118, width: 20, height: 64 },
      textX: 105,
      textY: 150,
      leader: { x1: 105, y1: 105, x2: 105, y2: 118 },
    });
  });

  it('shifts the box and leader end by offsetX while the leader start stays on the dot', () => {
    const geometry = layoutEventLabel(
      { x: 100, y: 100, width: 10, height: 10 },
      { ...opts, offsetX: 12 },
    );
    expect(geometry?.textX).toBe(117);
    expect(geometry?.box.x).toBe(107);
    expect(geometry?.leader).toEqual({ x1: 105, y1: 105, x2: 117, y2: 118 });
  });

  it('flips above the dot when there is no room below, leader meeting the box bottom', () => {
    const geometry = layoutEventLabel(
      { x: 100, y: 270, width: 10, height: 10 },
      { ...opts, title: 'Umzug' },
    );
    // 'Umzug' -> 40px box; dot bottom 280 leaves 10px below (needs 48).
    expect(geometry?.box).toEqual({ x: 95, y: 222, width: 20, height: 40 });
    expect(geometry?.leader).toEqual({ x1: 105, y1: 275, x2: 105, y2: 262 });
    expect(geometry?.textY).toBe(242);
  });

  it('keeps even the tallest box inside the plot band for any dot position and script', () => {
    const titles = [
      'A very long event title that overflows the chart',
      '容量拡張計画容量拡張計画容量拡張計画',
      'Migration Plan 🚀🚀🚀🚀',
    ];
    for (const title of titles) {
      for (const compact of [false, true]) {
        for (let y = PLOT_TOP; y <= PLOT_BOTTOM - 10; y += 4) {
          const geometry = layoutEventLabel(
            { x: 100, y, width: 10, height: 10 },
            { title, compact, offsetX: 0 },
          );
          expect(geometry).not.toBeNull();
          if (!geometry) continue;
          expect(geometry.box.y).toBeGreaterThanOrEqual(PLOT_TOP);
          expect(geometry.box.y + geometry.box.height).toBeLessThanOrEqual(PLOT_BOTTOM);
        }
      }
    }
  });
});

describe('planEventLabelOffsets', () => {
  it('returns an empty plan for no events', () => {
    expect(
      planEventLabelOffsets({ events: [], monthCount: 12, chartWidth: 800, compact: false }).size,
    ).toBe(0);
  });

  it('fans same-month events into symmetric columns before the chart width is known', () => {
    const two = planEventLabelOffsets({
      events: [
        { id: 'a', monthIndex: 1 },
        { id: 'b', monthIndex: 1 },
      ],
      monthCount: 3,
      chartWidth: null,
      compact: false,
    });
    expect(two.get('a')).toBe(-12);
    expect(two.get('b')).toBe(12);

    const three = planEventLabelOffsets({
      events: [
        { id: 'a', monthIndex: 1 },
        { id: 'b', monthIndex: 1 },
        { id: 'c', monthIndex: 1 },
      ],
      monthCount: 3,
      chartWidth: null,
      compact: false,
    });
    expect(three.get('a')).toBe(-24);
    expect(three.get('b')).toBe(0);
    expect(three.get('c')).toBe(24);
  });

  it('keeps a symmetric same-month fan when there is room, and clamps at the plot edges', () => {
    // 800px chart, 3 months: dots at x 68 / 406 / 744 (plot 68..744).
    const offsets = planEventLabelOffsets({
      events: [
        { id: 'first', monthIndex: 0 },
        { id: 'mid-a', monthIndex: 1 },
        { id: 'mid-b', monthIndex: 1 },
        { id: 'last', monthIndex: 2 },
      ],
      monthCount: 3,
      chartWidth: 800,
      compact: false,
    });
    // First-month box would overhang the y-axis; it is pushed right so its
    // left edge sits on the plot edge. Last-month box is pushed left likewise.
    expect(offsets.get('first')).toBe(10);
    expect(offsets.get('mid-a')).toBe(-12);
    expect(offsets.get('mid-b')).toBe(12);
    expect(offsets.get('last')).toBe(-10);
  });

  it('separates adjacent-month labels when the month pitch is narrower than a box', () => {
    // Compact phone width: plot 68..359 (291px), 24 months -> ~12.65px pitch,
    // narrower than the 19px box.
    const pitch = 291 / 23;
    const offsets = planEventLabelOffsets({
      events: [
        { id: 'a', monthIndex: 10 },
        { id: 'b', monthIndex: 11 },
      ],
      monthCount: 24,
      chartWidth: 375,
      compact: true,
    });
    expect(offsets.get('a')).toBe(0);
    // b is pushed right so the boxes sit exactly minSep (21px) apart.
    expect(offsets.get('b')).toBeCloseTo(21 - pitch, 4);
  });

  it('pulls a same-month fan back inside the right plot edge, preserving separation', () => {
    // Compact, 12 months, all three events in the last month (dot on the right
    // plot edge at x 359, maxX 349.5).
    const offsets = planEventLabelOffsets({
      events: [
        { id: 'a', monthIndex: 11 },
        { id: 'b', monthIndex: 11 },
        { id: 'c', monthIndex: 11 },
      ],
      monthCount: 12,
      chartWidth: 375,
      compact: true,
    });
    expect(offsets.get('c')).toBeCloseTo(-9.5, 4);
    expect(offsets.get('b')).toBeCloseTo(-30.5, 4);
    expect(offsets.get('a')).toBeCloseTo(-51.5, 4);
  });

  it('degrades gracefully when there is not enough room for every label', () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, monthIndex: 0 }));
    const offsets = planEventLabelOffsets({
      events,
      monthCount: 6,
      chartWidth: 375,
      compact: true,
    });
    expect(offsets.size).toBe(30);
    for (const event of events) {
      const offset = offsets.get(event.id);
      expect(offset).toBeDefined();
      if (offset === undefined) continue;
      expect(Number.isFinite(offset)).toBe(true);
      // Planned centre stays inside the plot (dot x is 68, box half-width 9.5).
      const x = 68 + offset;
      expect(x).toBeGreaterThanOrEqual(77.5);
      expect(x).toBeLessThanOrEqual(349.5);
    }
  });
});
