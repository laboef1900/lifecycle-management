/**
 * Pure geometry for the boxed event labels on the cluster forecast chart.
 *
 * @ai-context forecast-chart.tsx draws one label per event dot via recharts'
 * ReferenceDot `label` render callback. All placement math lives here, free of
 * recharts/React, so the flip/clamp/collision branches are unit-testable.
 * @ai-note These constants ARE the chart layout: forecast-chart.tsx consumes
 * CHART_HEIGHT for the canvas wrapper, CHART_MARGIN for the ComposedChart
 * margins and Y_AXIS_WIDTH/X_AXIS_HEIGHT for the axes, so the plot band
 * derived here stays in lockstep with what recharts actually renders.
 */

export const CHART_HEIGHT = 320;
export const CHART_MARGIN = { top: 12, right: 56, rightCompact: 16, bottom: 0, left: 8 } as const;
export const Y_AXIS_WIDTH = 60;
export const X_AXIS_HEIGHT = 30;
const PLOT_TOP = CHART_MARGIN.top;
const PLOT_BOTTOM = CHART_HEIGHT - CHART_MARGIN.bottom - X_AXIS_HEIGHT;

const LEADER_GAP = 8;
const BOX_PAD_X = 4;
const BOX_PAD_Y = 5;
/** Extra clearance between neighbouring label boxes in the collision sweep. */
const BOX_CLEARANCE = 2;

// East-Asian wide and emoji ranges render at roughly 1em per glyph instead of
// the ~0.6em Latin average; the box height estimate accounts for that.
const WIDE_CHAR =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F000}-\u{1FAFF}]/u;

// Glyph widths are tracked in integer tenths of an em (narrow 0.6em, wide
// 1em) so budget comparisons are exact — float accumulation of 0.6 would
// otherwise truncate one glyph early at the budget boundary.
const NARROW_GLYPH_TENTHS = 6;
const WIDE_GLYPH_TENTHS = 10;

function fontSizeFor(compact: boolean): number {
  return compact ? 9 : 10;
}

function glyphTenths(glyph: string): number {
  return WIDE_CHAR.test(glyph) ? WIDE_GLYPH_TENTHS : NARROW_GLYPH_TENTHS;
}

// Text budget per label, in em-tenths: 18 narrow glyphs (12 in compact).
// Budgeting by width rather than glyph count keeps wide-glyph (CJK/emoji)
// titles from producing boxes taller than the plot band can fit on either
// side of a dot.
function textBudgetTenths(compact: boolean): number {
  return (compact ? 12 : 18) * NARROW_GLYPH_TENTHS;
}

/**
 * Truncates an event title to the label's width budget, glyph-width aware.
 * Operates on code points (not UTF-16 units) so surrogate pairs are never
 * split in half. At least one glyph is always kept before the ellipsis.
 */
export function truncateEventTitle(title: string, compact: boolean): string {
  const budget = textBudgetTenths(compact);
  const glyphs = Array.from(title.trim());
  const total = glyphs.reduce((sum, glyph) => sum + glyphTenths(glyph), 0);
  if (total <= budget) return glyphs.join('');

  let used = glyphTenths('…');
  let kept = '';
  for (const glyph of glyphs) {
    const width = glyphTenths(glyph);
    if (kept !== '' && used + width > budget) break;
    kept += glyph;
    used += width;
  }
  return `${kept.trimEnd()}…`;
}

/**
 * Estimated pixel size of a label box for the (already truncated) text. The
 * text is rotated -90°, so the box width follows the glyph height and the box
 * height follows the text length. Because truncation enforces the width
 * budget, the box height never exceeds the budget's pixels plus padding —
 * small enough to always fit the plot band above or below any dot.
 */
export function eventLabelBoxSize(
  text: string,
  compact: boolean,
): { width: number; height: number } {
  const fontSize = fontSizeFor(compact);
  const textTenths = Array.from(text).reduce((sum, glyph) => sum + glyphTenths(glyph), 0);
  return {
    width: Math.round(fontSize * 1.2) + BOX_PAD_X * 2,
    height: Math.round((textTenths * fontSize) / 10) + BOX_PAD_Y * 2,
  };
}

export interface PlannableEvent {
  id: string;
  /** Index of the event's month in the forecast window (0-based). */
  monthIndex: number;
}

export interface EventLabelPlanInput {
  /** Events that actually render a dot, in forecast order. */
  events: readonly PlannableEvent[];
  /** Number of months in the forecast window (data points on the x-axis). */
  monthCount: number;
  /** Measured SVG width from ResponsiveContainer; null before the first measure. */
  chartWidth: number | null;
  compact: boolean;
}

/**
 * Plans a horizontal offset (relative to each event's dot) for every label so
 * that boxes never overlap and never leave the plot area: same-month events
 * fan out into adjacent columns, then a global left-to-right sweep resolves
 * cross-month collisions and clamps to the plot edges. Before the chart width
 * is known, only the same-month fan is applied.
 */
export function planEventLabelOffsets(input: EventLabelPlanInput): Map<string, number> {
  const { events, monthCount, chartWidth, compact } = input;
  const boxWidth = eventLabelBoxSize('', compact).width;
  const fanGap = boxWidth + 4;

  // Same-month fan: spread each month's labels into columns centred on the dot.
  const byMonth = new Map<number, PlannableEvent[]>();
  for (const event of events) {
    const bucket = byMonth.get(event.monthIndex) ?? [];
    bucket.push(event);
    byMonth.set(event.monthIndex, bucket);
  }
  const fanOffset = new Map<string, number>();
  for (const bucket of byMonth.values()) {
    bucket.forEach((event, index) => {
      fanOffset.set(event.id, (index - (bucket.length - 1) / 2) * fanGap);
    });
  }
  if (chartWidth === null) return fanOffset;

  const plotLeft = CHART_MARGIN.left + Y_AXIS_WIDTH;
  const plotRight = chartWidth - (compact ? CHART_MARGIN.rightCompact : CHART_MARGIN.right);
  const plotWidth = plotRight - plotLeft;
  const minX = plotLeft + boxWidth / 2;
  const maxX = plotRight - boxWidth / 2;
  if (plotWidth <= boxWidth || maxX <= minX) return fanOffset;

  // The x-axis is a point scale with zero padding: the first month sits on the
  // plot's left edge and the last on its right edge.
  const pitch = monthCount > 1 ? plotWidth / (monthCount - 1) : 0;
  const labels = events
    .map((event, order) => {
      const dotX = plotLeft + event.monthIndex * pitch;
      return { id: event.id, dotX, desiredX: dotX + (fanOffset.get(event.id) ?? 0), order };
    })
    .sort((a, b) => a.desiredX - b.desiredX || a.order - b.order);

  // Left-to-right sweep enforcing a minimum separation, then a right-to-left
  // pull-back when the sweep overshoots the right edge. If there is genuinely
  // not enough room for every box, the left clamp wins and boxes pile up (and
  // overlap) at the left plot edge rather than escaping the plot.
  const minSep = boxWidth + BOX_CLEARANCE;
  const placed: number[] = [];
  for (const [i, label] of labels.entries()) {
    const prev = placed[i - 1];
    placed.push(Math.max(label.desiredX, minX, prev === undefined ? -Infinity : prev + minSep));
  }
  const last = placed[placed.length - 1];
  if (last !== undefined && last > maxX) {
    placed[placed.length - 1] = maxX;
    for (let i = placed.length - 2; i >= 0; i--) {
      const right = placed[i + 1];
      const current = placed[i];
      if (right === undefined || current === undefined) continue;
      placed[i] = Math.max(Math.min(current, right - minSep), minX);
    }
  }

  const offsets = new Map<string, number>();
  labels.forEach((label, i) => {
    const x = placed[i];
    if (x !== undefined) offsets.set(label.id, x - label.dotX);
  });
  return offsets;
}

/** Structural shape of the viewBox recharts passes to a ReferenceDot label. */
export interface EventLabelViewBox {
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

export interface EventLabelGeometry {
  text: string;
  fontSize: number;
  box: { x: number; y: number; width: number; height: number };
  textX: number;
  textY: number;
  leader: { x1: number; y1: number; x2: number; y2: number };
}

/**
 * Computes the full geometry for one label given its dot's viewBox
 * ({ x: cx - r, y: cy - r, width: 2r, height: 2r } in recharts 2 and 3).
 * Labels sit below the dot by default and flip above only when there isn't
 * room below, so low datapoints near the x-axis don't clip. Returns null for
 * a missing or malformed viewBox.
 */
export function layoutEventLabel(
  viewBox: EventLabelViewBox | undefined,
  opts: { title: string; compact: boolean; offsetX: number },
): EventLabelGeometry | null {
  if (!viewBox) return null;
  const vbX = Number(viewBox.x);
  const vbY = Number(viewBox.y);
  const vbW = Number(viewBox.width);
  const vbH = Number(viewBox.height);
  if (![vbX, vbY, vbW, vbH].every(Number.isFinite)) return null;

  const dotCx = vbX + vbW / 2;
  const dotCy = vbY + vbH / 2;
  const dotTop = vbY;
  const dotBottom = vbY + vbH;
  const centerX = dotCx + opts.offsetX;

  const text = truncateEventTitle(opts.title, opts.compact);
  const { width: boxWidth, height: boxHeight } = eventLabelBoxSize(text, opts.compact);
  const needed = boxHeight + LEADER_GAP;
  const roomBelow = PLOT_BOTTOM - dotBottom;
  const roomAbove = dotTop - PLOT_TOP;
  const below = needed <= roomBelow || roomBelow >= roomAbove;

  const boxTop = below ? dotBottom + LEADER_GAP : dotTop - LEADER_GAP - boxHeight;
  const leaderY = below ? boxTop : boxTop + boxHeight;
  const textY = boxTop + boxHeight / 2;

  return {
    text,
    fontSize: fontSizeFor(opts.compact),
    box: { x: centerX - boxWidth / 2, y: boxTop, width: boxWidth, height: boxHeight },
    textX: centerX,
    textY,
    leader: { x1: dotCx, y1: dotCy, x2: centerX, y2: leaderY },
  };
}
