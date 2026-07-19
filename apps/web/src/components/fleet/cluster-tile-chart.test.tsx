import type { ForecastMonthPoint } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { todayIso } from '@/lib/format';

import { ClusterTileChart } from './cluster-tile-chart';

// Distinct stroke per role so a hairline can be identified by what it IS rather
// than by its position in the JSX. `capacity` deliberately differs from
// `utilizationCrit` here, matching the real palette (`--chart-capacity` is a
// slate, `--destructive` a red) — they used to share a hex, which made the two
// lines indistinguishable to a test.
const WARN_STROKE = '#b45309';
const CRIT_STROKE = '#b91c1c';
const CAPACITY_STROKE = '#3a455e';

vi.mock('@/lib/use-chart-colors', () => ({
  useChartColors: () => ({
    consumption: '#8a6016',
    consumptionFill: 'rgba(138, 96, 22, 0.10)',
    capacity: '#3a455e',
    grid: '#e5e5e5',
    axis: '#737373',
    utilizationOk: '#525252',
    utilizationWarn: '#b45309',
    utilizationCrit: '#b91c1c',
    eventNamed: {},
    eventPalette: [],
  }),
}));

/**
 * The horizontal reference line carrying `stroke`, or null when none is drawn.
 * Order-independent by construction: reordering the JSX must not fail a test.
 */
function hairline(stroke: string): HTMLElement | null {
  return screen.queryAllByTestId(/^refline-y-/).find((el) => el.dataset.stroke === stroke) ?? null;
}

/** `'2026-07-01'` + delta months, for fixtures anchored to the real current month. */
function shiftMonth(monthIso: string, delta: number): string {
  const d = new Date(`${monthIso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

// `todayIso()` is the 1st of the CURRENT month, and the component splits
// actual/forecast at whichever fixture row matches it. Fixtures that assert on
// that split must therefore be built from it, not from a hardcoded date, or
// they silently change meaning once the calendar moves on.
const CURRENT_MONTH = todayIso();

// A minimal stand-in for the Recharts tooltip content render props — just the
// fields the tile chart's content function reads.
interface TooltipRenderProps {
  active?: boolean;
  label?: string;
  payload?: Array<{ payload?: unknown; value?: unknown }>;
}

vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }): React.JSX.Element => <>{children}</>;
  return {
    ResponsiveContainer: Pass,
    ComposedChart: ({ data, children }: { data: unknown; children?: React.ReactNode }) => (
      <div data-testid="chart" data-rows={JSON.stringify(data)}>
        {children}
      </div>
    ),
    XAxis: ({
      dataKey,
      tickFormatter,
      interval,
      minTickGap,
    }: {
      dataKey?: string;
      tickFormatter?: (value: string) => string;
      interval?: number | string;
      minTickGap?: number;
    }) => (
      <div
        data-testid="x-axis"
        data-key={dataKey}
        data-sample={tickFormatter ? tickFormatter('2026-07-01') : ''}
        data-interval={String(interval)}
        data-min-tick-gap={String(minTickGap)}
      />
    ),
    YAxis: ({
      domain,
      ticks,
      allowDataOverflow,
      tickFormatter,
    }: {
      domain: [number, number];
      ticks?: number[];
      allowDataOverflow?: boolean;
      tickFormatter?: (value: number) => string;
    }) => (
      <div
        data-testid="y-axis"
        data-domain={JSON.stringify(domain)}
        data-ticks={JSON.stringify(ticks)}
        data-allow-overflow={String(Boolean(allowDataOverflow))}
        data-sample={tickFormatter ? tickFormatter(100) : ''}
      />
    ),
    // Invoke the content render fn with a synthetic active payload so the tile's
    // tooltip logic (which must report the TRUE utilization) is exercised.
    Tooltip: ({ content }: { content: (props: TooltipRenderProps) => React.ReactNode }) => (
      <div data-testid="tooltip">
        {content({
          active: true,
          label: '2026-07-01',
          payload: [
            { payload: { month: '2026-07-01', util: 12.5, actual: 40, forecast: 40 }, value: 40 },
          ],
        })}
      </div>
    ),
    Area: ({ dataKey }: { dataKey: string }) => <div data-testid={`area-${dataKey}`} />,
    Line: ({ dataKey, strokeDasharray }: { dataKey: string; strokeDasharray?: string }) => (
      <div data-testid={`line-${dataKey}`} data-dash={strokeDasharray ?? ''} />
    ),
    // `data-y`, `data-stroke` and `data-dash` are surfaced alongside the testid
    // so a test can identify a hairline by its role (stroke) and assert both
    // where it sits and whether it is marked off-scale — including when two of
    // them clamp onto the same y and the testid alone would be ambiguous.
    ReferenceLine: ({
      x,
      y,
      stroke,
      strokeDasharray,
    }: {
      x?: string;
      y?: number;
      stroke?: string;
      strokeDasharray?: string;
    }) => (
      <div
        data-testid={x !== undefined ? `refline-x-${x}` : `refline-y-${y}`}
        data-y={y}
        data-stroke={stroke}
        data-dash={strokeDasharray}
      />
    ),
    ReferenceDot: ({ x, y, fill }: { x: string; y: number; fill?: string }) => (
      <div data-testid="breach-dot" data-x={x} data-y={y} data-fill={fill} />
    ),
  };
});

const months: ForecastMonthPoint[] = [
  { month: '2026-07-01', consumption: 700, capacity: 1000, utilization: 0.7 },
  { month: '2026-08-01', consumption: 800, capacity: 1000, utilization: 0.8 },
  { month: '2026-09-01', consumption: 920, capacity: 1000, utilization: 0.92 },
  { month: '2026-10-01', consumption: 1000, capacity: 1000, utilization: 1.0 },
];

describe('<ClusterTileChart>', () => {
  // jsdom doesn't recognise SVG namespace elements like <linearGradient> (used
  // for the area-fill gradient below) and warns about casing; the warnings
  // don't affect the assertions — same suppression as forecast-chart.test.tsx.
  let originalError: typeof console.error;
  beforeAll(() => {
    originalError = console.error;
    console.error = (...args: unknown[]) => {
      const first = args[0];
      if (
        typeof first === 'string' &&
        (first.includes('unrecognized in this browser') || first.includes('incorrect casing'))
      ) {
        return;
      }
      originalError(...args);
    };
  });
  afterAll(() => {
    console.error = originalError;
  });

  it('renders nothing when there are no months', () => {
    const { container } = render(
      <ClusterTileChart months={[]} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('uses a fixed, tightened 40-125 y-domain shared across tiles (spec §4.4, amended)', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    const yAxis = screen.getByTestId('y-axis');
    expect(yAxis.dataset.domain).toBe('[40,125]');
    // allowDataOverflow keeps the shared window fixed against out-of-range data.
    expect(yAxis.dataset.allowOverflow).toBe('true');
    // Y ticks are labeled as percentages.
    expect(yAxis.dataset.ticks).toBe('[50,75,100]');
    expect(yAxis.dataset.sample).toBe('100%');
  });

  it('describes the shared 40-125 scale in the chart aria-label', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('shared 40 to 125 percent scale across tiles');
    expect(label).toContain('Warn threshold 70 percent');
  });

  it('labels the x-axis with short month names (no longer hidden)', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    const xAxis = screen.getByTestId('x-axis');
    expect(xAxis.dataset.key).toBe('month');
    expect(xAxis.dataset.sample).toBe('Jul 26'); // formatMonthShort('2026-07-01')
  });

  it('thins x-axis labels so 12 months cannot collide at tile width (#224 point 1)', () => {
    // These two props are the entire anti-overlap mechanism: at ~1/3-tile width
    // a 12-month window would otherwise stack month labels on top of each other.
    // Recharts' defaults (interval="preserveEnd", minTickGap=5) are NOT enough,
    // so a silent revert to them must fail here.
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    const xAxis = screen.getByTestId('x-axis');
    expect(xAxis.dataset.interval).toBe('preserveStartEnd');
    expect(xAxis.dataset.minTickGap).toBe('28');
  });

  it('splits consumption into an actual line up to the current month and a forecast line after', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    expect(screen.getByTestId('line-actual')).toBeInTheDocument();
    expect(screen.getByTestId('line-forecast')).toBeInTheDocument();
    const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
      month: string;
      util: number;
      actual: number | null;
      forecast: number | null;
    }>;
    // The fetched window always starts at the current month (index 0), so the
    // "actual" series is the single anchor point and everything (including
    // that same anchor) is also part of the dashed "forecast" series. All these
    // values are within [40,125] so the plotted line equals the true util.
    expect(rows[0]).toEqual({ month: '2026-07-01', util: 70, actual: 70, forecast: 70 });
    expect(rows[1]).toEqual({ month: '2026-08-01', util: 80, actual: null, forecast: 80 });
  });

  it('keeps the actual segment solid (no dash) and the forecast segment dashed', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    expect(screen.getByTestId('line-actual').dataset.dash).toBe('');
    expect(screen.getByTestId('line-forecast').dataset.dash).not.toBe('');
  });

  it('fills a low-opacity area under both the actual and forecast segments', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    expect(screen.getByTestId('area-actual')).toBeInTheDocument();
    expect(screen.getByTestId('area-forecast')).toBeInTheDocument();
  });

  it('drops the horizontal CartesianGrid so warn/crit/capacity are the only reference lines', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    expect(screen.queryByTestId('grid')).not.toBeInTheDocument();
  });

  it('clamps below-floor utilization to the window edge while keeping the true value for the tooltip', () => {
    // Zero/unknown-capacity clusters (#198) report 0% and would sit entirely
    // below the 40% floor. The plotted line pins to the floor so it stays
    // visible; the true util is preserved on the row for the tooltip.
    const lowMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 100, capacity: 1000, utilization: 0.1 },
      { month: '2026-08-01', consumption: 0, capacity: 0, utilization: 0 },
    ];
    render(
      <ClusterTileChart
        months={lowMonths}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
      month: string;
      util: number;
      actual: number | null;
      forecast: number | null;
    }>;
    expect(rows[0]).toEqual({ month: '2026-07-01', util: 10, actual: 40, forecast: 40 });
    expect(rows[1]).toEqual({ month: '2026-08-01', util: 0, actual: null, forecast: 40 });
  });

  it('clamps above-ceiling utilization to the window top so it cannot stretch the shared scale', () => {
    // A cluster already past capacity (>125 %) must pin to the ceiling: letting
    // it through would either expand the axis (breaking cross-tile
    // comparability) or, with allowDataOverflow, draw off-window.
    // Anchored to the real current month so the actual/forecast split below
    // stays index 0 whatever month the suite runs in.
    const overMonths: ForecastMonthPoint[] = [
      { month: CURRENT_MONTH, consumption: 1400, capacity: 1000, utilization: 1.4 },
      { month: shiftMonth(CURRENT_MONTH, 1), consumption: 1600, capacity: 1000, utilization: 1.6 },
    ];
    render(
      <ClusterTileChart
        months={overMonths}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
      month: string;
      util: number;
      actual: number | null;
      forecast: number | null;
    }>;
    // True util is preserved for the tooltip; only the plotted values clamp.
    expect(rows[0]).toEqual({ month: CURRENT_MONTH, util: 140, actual: 125, forecast: 125 });
    expect(rows[1]).toEqual({
      month: shiftMonth(CURRENT_MONTH, 1),
      util: 160,
      actual: null,
      forecast: 125,
    });
    // The breach dot rides the same clamp — at util 140 it must sit at 125.
    expect(screen.getByTestId('breach-dot').dataset.y).toBe('125');
  });

  it('pins the breach dot to the floor when the warn threshold is below the window', () => {
    // Mirror of the above: warn=0.05 makes month 0 (10 % util) a breach, and the
    // dot must clamp UP to the 40 % floor rather than render off-window.
    const lowMonths: ForecastMonthPoint[] = [
      { month: CURRENT_MONTH, consumption: 100, capacity: 1000, utilization: 0.1 },
    ];
    render(
      <ClusterTileChart
        months={lowMonths}
        thresholds={{ warn: 0.05, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    expect(screen.getByTestId('breach-dot').dataset.y).toBe('40');
  });

  it('tooltip reports the true utilization, not the clamped plotted value', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    // The mock feeds the content fn a payload whose true util is 12.5 while the
    // plotted (clamped) value is 40 — the tooltip must show 12.5%.
    const tooltip = screen.getByTestId('tooltip');
    expect(tooltip).toHaveTextContent('12.5%');
    expect(tooltip).not.toHaveTextContent('40.0%');
  });

  it('draws warn, crit, and 100% capacity reference lines', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    expect(screen.getByTestId('refline-y-70')).toBeInTheDocument();
    expect(screen.getByTestId('refline-y-90')).toBeInTheDocument();
    expect(screen.getByTestId('refline-y-100')).toBeInTheDocument();
  });

  it('clamps a sub-40% warn threshold up to the floor and marks it off-scale', () => {
    // percentSchema allows thresholds down to 0.01, so warn=0.35 is a legal,
    // saveable config. Recharts' ReferenceLine defaults to ifOverflow="discard"
    // and would render NOTHING below the 40% floor — while the breach dot still
    // pins to the floor and the aria-label still names the threshold. Clamping
    // keeps the tile self-consistent; the off-scale dash keeps it honest, so a
    // hairline pinned at 40% cannot be read as "warn is configured at 40%".
    render(
      <ClusterTileChart
        months={months}
        thresholds={{ warn: 0.35, crit: 0.5 }}
        orderByDate={null}
      />,
    );
    expect(hairline(WARN_STROKE)?.dataset.y).toBe('40');
    expect(hairline(WARN_STROKE)?.dataset.dash).toBe('1 2'); // off-scale cue
    // Crit is inside the window, so it keeps the normal hairline dash —
    // proving the cue tracks the clamp rather than being applied blanket.
    expect(hairline(CRIT_STROKE)?.dataset.y).toBe('50');
    expect(hairline(CRIT_STROKE)?.dataset.dash).toBe('4 3');
    expect(hairline(CAPACITY_STROKE)?.dataset.y).toBe('100');
  });

  it('merges warn into crit when BOTH clamp to the same edge, instead of hiding warn under it', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.2, crit: 0.3 }} orderByDate={null} />,
    );
    // Both thresholds sit below the window and clamp to the same y. Drawing two
    // coincident hairlines would render warn permanently invisible beneath crit
    // while still implying two bands; a single off-scale line in the more severe
    // color is what the scale can actually show.
    expect(hairline(WARN_STROKE)).toBeNull();
    expect(hairline(CRIT_STROKE)?.dataset.y).toBe('40');
    expect(hairline(CRIT_STROKE)?.dataset.dash).toBe('1 2');
    expect(hairline(CAPACITY_STROKE)?.dataset.y).toBe('100');
    // The clamp and the merge are presentational only — the accessible
    // description must still report the REAL configured percentages.
    const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('Warn threshold 20 percent');
    expect(label).toContain('Critical threshold 30 percent');
  });

  it('marks the first month at or above warn with a breach dot filled in the warn color, not crit (PR review fix 4a)', () => {
    // The dot is positioned at the warn-threshold crossing (`thresholds.warn`
    // in `breachIndex`), so its fill must be `utilizationWarn` — filling it
    // with `utilizationCrit` visually mislabels a warn breach as a crit one.
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    const dot = screen.getByTestId('breach-dot');
    expect(dot.dataset.x).toBe('2026-07-01');
    expect(dot.dataset.fill).toBe('#b45309'); // utilizationWarn — not utilizationCrit (#b91c1c)
  });

  it('omits the breach dot when no month reaches warn', () => {
    const lowMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 100, capacity: 1000, utilization: 0.1 },
    ];
    render(
      <ClusterTileChart
        months={lowMonths}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    expect(screen.queryByTestId('breach-dot')).toBeNull();
  });

  it('draws an order-by marker when the order-by month falls in range', () => {
    // Anchored to CURRENT_MONTH (index 0, so the NOW marker below stays
    // suppressed) rather than the shared `months` fixture, whose hardcoded
    // '2026-09-01' would collide with the NOW marker's own testid in the one
    // real month where that literally is the current month.
    const monthsFromNow: ForecastMonthPoint[] = [
      { month: CURRENT_MONTH, consumption: 700, capacity: 1000, utilization: 0.7 },
      { month: shiftMonth(CURRENT_MONTH, 1), consumption: 800, capacity: 1000, utilization: 0.8 },
      { month: shiftMonth(CURRENT_MONTH, 2), consumption: 920, capacity: 1000, utilization: 0.92 },
    ];
    const orderByMonth = shiftMonth(CURRENT_MONTH, 2);
    render(
      <ClusterTileChart
        months={monthsFromNow}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate={`${orderByMonth.slice(0, 8)}14`}
      />,
    );
    expect(screen.getByTestId(`refline-x-${orderByMonth}`)).toBeInTheDocument();
  });

  it('omits the order-by marker when there is no order-by date', () => {
    // CURRENT_MONTH at index 0 keeps the NOW marker suppressed too, so this
    // stays a clean check that nothing renders on the x-axis at all.
    const monthsFromNow: ForecastMonthPoint[] = [
      { month: CURRENT_MONTH, consumption: 700, capacity: 1000, utilization: 0.7 },
      { month: shiftMonth(CURRENT_MONTH, 1), consumption: 800, capacity: 1000, utilization: 0.8 },
    ];
    render(
      <ClusterTileChart
        months={monthsFromNow}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    expect(screen.queryByTestId(/refline-x-/)).toBeNull();
  });

  it('renders an unlabeled steel NOW reference line at the current month when it is not the first plotted point', () => {
    const monthsWithHistory: ForecastMonthPoint[] = [
      { month: shiftMonth(CURRENT_MONTH, -1), consumption: 600, capacity: 1000, utilization: 0.6 },
      { month: CURRENT_MONTH, consumption: 700, capacity: 1000, utilization: 0.7 },
      { month: shiftMonth(CURRENT_MONTH, 1), consumption: 800, capacity: 1000, utilization: 0.8 },
    ];
    render(
      <ClusterTileChart
        months={monthsWithHistory}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    const nowLine = screen.getByTestId(`refline-x-${CURRENT_MONTH}`);
    expect(nowLine).toBeInTheDocument();
    expect(nowLine.dataset.stroke).toBe('var(--steel)');
  });

  it('omits the NOW marker when the window opens at the current month (it would sit on the y-axis)', () => {
    const monthsStartingNow: ForecastMonthPoint[] = [
      { month: CURRENT_MONTH, consumption: 700, capacity: 1000, utilization: 0.7 },
      { month: shiftMonth(CURRENT_MONTH, 1), consumption: 800, capacity: 1000, utilization: 0.8 },
    ];
    render(
      <ClusterTileChart
        months={monthsStartingNow}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    expect(screen.queryByTestId(`refline-x-${CURRENT_MONTH}`)).not.toBeInTheDocument();
  });
});
