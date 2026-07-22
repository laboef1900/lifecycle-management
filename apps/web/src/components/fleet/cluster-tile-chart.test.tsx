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
    eventAdds: '#176b45',
    eventConsumes: '#c0343c',
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
    // Invoke the content render fn with synthetic active payloads so the tile's
    // tooltip logic is exercised directly. Two payloads, two branches: one with
    // a numeric util (must report the TRUE value, not the clamped plot value)
    // and one with util:null (a capacity-0 month — must say "unknown", never a
    // number). Without the null case the `: 'unknown'` branch is uncovered,
    // since the payload is the mock's, not the component's.
    Tooltip: ({ content }: { content: (props: TooltipRenderProps) => React.ReactNode }) => (
      <>
        <div data-testid="tooltip">
          {content({
            active: true,
            label: '2026-07-01',
            payload: [
              { payload: { month: '2026-07-01', util: 12.5, actual: 40, forecast: 40 }, value: 40 },
            ],
          })}
        </div>
        <div data-testid="tooltip-unknown">
          {content({
            active: true,
            label: '2026-08-01',
            payload: [
              {
                payload: { month: '2026-08-01', util: null, actual: null, forecast: null },
                value: 0,
              },
            ],
          })}
        </div>
      </>
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

  it("scales the y-domain to the tile's own data, centring the line (#268)", () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    const yAxis = screen.getByTestId('y-axis');
    // Data spans 70-100; symmetric 18% padding gives 64.6-105.4, so the series
    // midpoint (85) is the domain midpoint too — that centring IS the feature.
    expect(yAxis.dataset.domain).toBe('[64.6,105.4]');
    const [min, max] = JSON.parse(yAxis.dataset.domain ?? '[]') as [number, number];
    expect((min + max) / 2).toBeCloseTo(85, 6);
    // allowDataOverflow now protects the CENTRING (it stops Recharts widening
    // the computed window), not cross-tile comparability.
    expect(yAxis.dataset.allowOverflow).toBe('true');
  });

  it('derives nice round y ticks from that domain instead of a hardcoded 50/75/100', () => {
    // The ticks stopped being decoration when the shared window went away: they
    // are the ONLY per-tile cue to where on the scale a tile sits, so a silent
    // regression to a fixed set has to fail here.
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    const yAxis = screen.getByTestId('y-axis');
    expect(yAxis.dataset.ticks).toBe('[70,80,90,100]');
    expect(yAxis.dataset.sample).toBe('100%');
  });

  it('gives a different cluster a different domain — the scale is per-tile, not shared', () => {
    // The invariant reversal in one assertion: a low-utilization cluster must
    // NOT land on the same window as the 70-100% fixture above.
    const lowMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 300, capacity: 1000, utilization: 0.3 },
      { month: '2026-08-01', consumption: 360, capacity: 1000, utilization: 0.36 },
    ];
    render(
      <ClusterTileChart
        months={lowMonths}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    const [min, max] = JSON.parse(screen.getByTestId('y-axis').dataset.domain ?? '[]') as [
      number,
      number,
    ];
    expect(max).toBeLessThan(64.6); // entirely below the other fixture's window
    expect((min + max) / 2).toBeCloseTo(33, 6); // still centred on its own data
  });

  it('widens a flat series to a minimum span so noise cannot look like a climb', () => {
    const flatMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 600, capacity: 1000, utilization: 0.6 },
      { month: '2026-08-01', consumption: 600, capacity: 1000, utilization: 0.6 },
    ];
    render(
      <ClusterTileChart
        months={flatMonths}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    const [min, max] = JSON.parse(screen.getByTestId('y-axis').dataset.domain ?? '[]') as [
      number,
      number,
    ];
    expect(max - min).toBeGreaterThanOrEqual(12);
    expect((min + max) / 2).toBeCloseTo(60, 6);
  });

  it('describes the per-tile scale in the chart aria-label, not a shared one', () => {
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.7, crit: 0.9 }} orderByDate={null} />,
    );
    const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
    // The old copy promised a "shared 40 to 125 percent scale across tiles".
    // Leaving that in place would tell a non-sighted reader the axis matches
    // the tile next to it, which is now false.
    expect(label).not.toContain('shared');
    expect(label).toContain("scaled to this cluster's own range");
    expect(label).toContain('65 to 105 percent');
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
    // that same anchor) is also part of the dashed "forecast" series. The
    // plotted values ARE the true utils — with a data-derived domain there is
    // no clamping left to diverge them (#268).
    expect(rows[0]).toEqual({
      month: '2026-07-01',
      util: 70,
      actual: 70,
      forecast: 70,
    });
    expect(rows[1]).toEqual({
      month: '2026-08-01',
      util: 80,
      actual: null,
      forecast: 80,
    });
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

  it('no longer clamps the data series — the domain contains every row by construction (#268)', () => {
    // Under the retired 40-125 window, a zero/unknown-capacity cluster (#198)
    // reading 0% plotted pinned at the 40% floor and needed an off-scale dash
    // so it could not be misread as genuine 40% utilization. A data-derived
    // domain removes the premise: the window is built FROM these values, so
    // the plotted value always equals the true one and the whole off-scale
    // apparatus for the data series is gone rather than merely unused.
    const lowMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 100, capacity: 1000, utilization: 0.1 },
      { month: '2026-08-01', consumption: 200, capacity: 1000, utilization: 0.2 },
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
      util: number | null;
      actual: number | null;
      forecast: number | null;
    }>;
    expect(rows[0]).toEqual({ month: '2026-07-01', util: 10, actual: 10, forecast: 10 });
    expect(rows[1]).toEqual({ month: '2026-08-01', util: 20, actual: null, forecast: 20 });
    expect(screen.queryByTestId('line-offScale')).toBeNull();
  });

  describe('zero capacity is unknowable, never 0% (recorded decision Q9d)', () => {
    // The retired fixed window clamped a 0 to the 40% floor AND dashed it
    // off-scale, which is what kept "0% used" off the chart. A data-derived
    // domain has no floor to clamp to, so without this the tile would draw a
    // confident flat line on a plausible 0-12% axis — contradicting its own
    // UNKNOWN badge and "add host capacity" verdict, on a purchasing surface.
    const zeroMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 0, capacity: 0, utilization: null },
      { month: '2026-08-01', consumption: 0, capacity: 0, utilization: null },
    ];

    it('plots no line at all when no month has recorded capacity', () => {
      render(
        <ClusterTileChart
          months={zeroMonths}
          thresholds={{ warn: 0.7, crit: 0.9 }}
          orderByDate={null}
        />,
      );
      const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
        util: number | null;
        actual: number | null;
        forecast: number | null;
      }>;
      expect(rows.every((r) => r.util === null && r.actual === null && r.forecast === null)).toBe(
        true,
      );
    });

    it('falls back to the full 0-100 axis instead of inventing a range from absent data', () => {
      render(
        <ClusterTileChart
          months={zeroMonths}
          thresholds={{ warn: 0.7, crit: 0.9 }}
          orderByDate={null}
        />,
      );
      const yAxis = screen.getByTestId('y-axis');
      expect(yAxis.dataset.domain).toBe('[0,100]');
      // A 0-12% window with 0/5/10 ticks is the specific wrong answer: it makes
      // "no data" look like a precisely measured, extremely healthy cluster.
      expect(yAxis.dataset.ticks).toBe('[0,50,100]');
    });

    it('says utilization is unknown in the aria-label rather than describing a scale', () => {
      render(
        <ClusterTileChart
          months={zeroMonths}
          thresholds={{ warn: 0.7, crit: 0.9 }}
          orderByDate={null}
        />,
      );
      const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
      expect(label).toContain('utilization unknown');
      expect(label).toContain('no capacity recorded');
      expect(label).not.toContain('own range');
      // The 0-100 fallback still DRAWS the three hairlines (they are config, not
      // data), so a screen-reader user must hear the same references a sighted
      // one sees — all in-window here, so no "outside the visible range".
      expect(label).toContain('Warn threshold 70 percent.');
      expect(label).toContain('Critical threshold 90 percent.');
      expect(label).toContain('Capacity ceiling 100 percent.');
    });

    it('drops only the unmeasurable months when capacity is recorded for some', () => {
      const mixed: ForecastMonthPoint[] = [
        { month: '2026-07-01', consumption: 700, capacity: 1000, utilization: 0.7 },
        { month: '2026-08-01', consumption: 0, capacity: 0, utilization: null },
        { month: '2026-09-01', consumption: 800, capacity: 1000, utilization: 0.8 },
      ];
      render(
        <ClusterTileChart
          months={mixed}
          thresholds={{ warn: 0.7, crit: 0.9 }}
          orderByDate={null}
        />,
      );
      const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
        util: number | null;
      }>;
      expect(rows.map((r) => r.util)).toEqual([70, null, 80]);
      // The gap must not drag the domain toward zero — it is scaled off the two
      // measured months only.
      const [min] = JSON.parse(screen.getByTestId('y-axis').dataset.domain ?? '[]') as [number];
      expect(min).toBeGreaterThan(60);
      // Singular grammar for exactly one gap month ("1 month has", not
      // "1 months have") — the copy is baked into the accessible name.
      expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
        '1 month has no recorded capacity and is not plotted',
      );
    });

    it('pluralizes the gap-months clause for more than one', () => {
      const mixed: ForecastMonthPoint[] = [
        { month: '2026-07-01', consumption: 700, capacity: 1000, utilization: 0.7 },
        { month: '2026-08-01', consumption: 0, capacity: 0, utilization: null },
        { month: '2026-09-01', consumption: 0, capacity: 0, utilization: null },
      ];
      render(
        <ClusterTileChart
          months={mixed}
          thresholds={{ warn: 0.7, crit: 0.9 }}
          orderByDate={null}
        />,
      );
      expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
        '2 months have no recorded capacity and are not plotted',
      );
    });

    it('renders "unknown" in the tooltip for a capacity-0 month, never a number', () => {
      render(
        <ClusterTileChart
          months={zeroMonths}
          thresholds={{ warn: 0.7, crit: 0.9 }}
          orderByDate={null}
        />,
      );
      // The mock re-invokes the tooltip content fn with a util:null payload —
      // the shape this chart produces for a capacity-0 month — so this exercises
      // the component's own `: 'unknown'` branch.
      const unknown = screen.getByTestId('tooltip-unknown');
      expect(unknown).toHaveTextContent('unknown');
      // No percentage — a "0.0%" here would be the exact Q9d lie in the tooltip.
      expect(unknown.textContent).not.toContain('%');
    });
  });

  it('lets an above-100% cluster scale its own window instead of pinning to a ceiling', () => {
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
    expect(rows[0]).toEqual({ month: CURRENT_MONTH, util: 140, actual: 140, forecast: 140 });
    expect(rows[1]).toEqual({
      month: shiftMonth(CURRENT_MONTH, 1),
      util: 160,
      actual: null,
      forecast: 160,
    });
    // The breach dot sits on the true value now, with no clamp to ride.
    expect(screen.getByTestId('breach-dot').dataset.y).toBe('140');
    // Warn (70), crit (90) and the 100% ceiling all fall below this window, so
    // all three collapse onto the floor as a single merged off-scale hairline.
    // Below the window the NEAREST threshold is the highest one — the capacity
    // ceiling — not the most severe.
    const yLines = screen.queryAllByTestId(/^refline-y-/);
    expect(yLines).toHaveLength(1);
    expect(yLines[0]?.dataset.stroke).toBe(CAPACITY_STROKE);
    expect(yLines[0]?.dataset.dash).toBe('1 2');
  });

  it('shows the NEAREST threshold, not the most severe, when all of them clamp to one edge', () => {
    // A calm cluster at 30-36% is below warn, crit AND the 100% ceiling, so all
    // three pin to the top edge. Picking by severity would paint a crit-RED
    // line across the top of the healthiest tile in the fleet — an alarm on the
    // one cluster with nothing wrong. The useful line is the one it would hit
    // first: warn.
    const calmMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 300, capacity: 1000, utilization: 0.3 },
      { month: '2026-08-01', consumption: 360, capacity: 1000, utilization: 0.36 },
    ];
    render(
      <ClusterTileChart
        months={calmMonths}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    const yLines = screen.queryAllByTestId(/^refline-y-/);
    expect(yLines).toHaveLength(1);
    expect(yLines[0]?.dataset.stroke).toBe(WARN_STROKE);
    expect(yLines[0]?.dataset.dash).toBe('1 2');
    // All three true values still reach assistive tech.
    const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('Warn threshold 70 percent, outside the visible range');
    expect(label).toContain('Critical threshold 90 percent, outside the visible range');
    expect(label).toContain('Capacity ceiling 100 percent, outside the visible range');
  });

  it('still picks by severity when two thresholds collide at their TRUE values', () => {
    // Equal warn and crit is a legal config; neither is clamped, so the
    // nearest-threshold rule does not apply and crit must win.
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.9, crit: 0.9 }} orderByDate={null} />,
    );
    expect(hairline(WARN_STROKE)).toBeNull();
    expect(hairline(CRIT_STROKE)?.dataset.y).toBe('90');
    expect(hairline(CRIT_STROKE)?.dataset.dash).toBe('4 3');
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

  it('clamps an out-of-window threshold to the edge and marks it off-scale', () => {
    // A threshold is CONFIGURATION, not data, so unlike the data series it can
    // still fall outside a per-tile window — and with the window now fitted to
    // one cluster this is the normal case, not the sub-40% corner it used to
    // be. Recharts' ReferenceLine defaults to ifOverflow="discard" and would
    // render NOTHING, leaving a tile whose aria-label names a threshold it
    // never draws. Clamping keeps the tile self-consistent; the off-scale dash
    // keeps it honest.
    // Domain here is 64.6-105.4, so warn=60% falls just below the floor while
    // crit=90% sits inside.
    render(
      <ClusterTileChart months={months} thresholds={{ warn: 0.6, crit: 0.9 }} orderByDate={null} />,
    );
    expect(hairline(WARN_STROKE)?.dataset.y).toBe('64.6');
    expect(hairline(WARN_STROKE)?.dataset.dash).toBe('1 2'); // off-scale cue
    // Crit is inside the window, so it keeps the normal hairline dash —
    // proving the cue tracks the clamp rather than being applied blanket.
    expect(hairline(CRIT_STROKE)?.dataset.y).toBe('90');
    expect(hairline(CRIT_STROKE)?.dataset.dash).toBe('4 3');
    expect(hairline(CAPACITY_STROKE)?.dataset.y).toBe('100');

    // The pinned hairline sits at 64.6%, not the configured 60% — the spoken
    // percentage is the only place the true value survives, so it must say so.
    const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('Warn threshold 60 percent, outside the visible range');
    expect(label).toContain('Critical threshold 90 percent.');
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
    expect(hairline(CRIT_STROKE)?.dataset.y).toBe('64.6');
    expect(hairline(CRIT_STROKE)?.dataset.dash).toBe('1 2');
    // Capacity is inside this window, so it survives the merge as its own line.
    expect(hairline(CAPACITY_STROKE)?.dataset.y).toBe('100');
    // The clamp and the merge are presentational only — the accessible
    // description must still report the REAL configured percentages.
    const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('Warn threshold 20 percent');
    expect(label).toContain('Critical threshold 30 percent');
  });

  it('merges the capacity ceiling away when crit clamps to the same edge, keeping an in-window warn intact', () => {
    // Severity decides a collision, and capacity ranks below both thresholds:
    // on a healthy tile the 100% ceiling and crit both pin to the top edge, and
    // drawing them coincident would hide one under the other while implying two
    // readable references. The surviving line carries the off-scale dash, so it
    // cannot be read as a ceiling genuinely configured at 41%.
    const lowMonths: ForecastMonthPoint[] = [
      { month: '2026-07-01', consumption: 300, capacity: 1000, utilization: 0.3 },
      { month: '2026-08-01', consumption: 360, capacity: 1000, utilization: 0.36 },
    ];
    render(
      <ClusterTileChart
        months={lowMonths}
        thresholds={{ warn: 0.31, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    const capacityLine = hairline(CAPACITY_STROKE);
    // Crit (90%) outranks capacity at the shared top edge, so capacity is the
    // one that gets merged away here — assert on whichever survived.
    expect(capacityLine).toBeNull();
    expect(hairline(CRIT_STROKE)?.dataset.dash).toBe('1 2');
    // Warn at 31% is inside this window and keeps its true position.
    expect(hairline(WARN_STROKE)?.dataset.y).toBe('31');
    expect(hairline(WARN_STROKE)?.dataset.dash).toBe('4 3');
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
    // Anchored to CURRENT_MONTH (rather than the shared `months` fixture,
    // whose hardcoded '2026-09-01' would collide with the NOW marker's own
    // testid in the one real month where that literally is the current
    // month). The NOW marker renders here too (foundIndex 0), at a different
    // x than the order-by month, so it doesn't interfere with this lookup.
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

  it('omits the order-by marker when there is no order-by date, though the NOW marker still renders', () => {
    // #243 Part B review: a real tile's `months` always opens at the current
    // month (unlike ForecastChart, it never gets leading baseline-history
    // rows), so `foundIndex` is 0 on every production tile — the NOW marker
    // is expected here too. Only the order-by marker, which would sit at a
    // DIFFERENT month, must be absent.
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
    const xLines = screen.queryAllByTestId(/^refline-x-/);
    expect(xLines).toHaveLength(1);
    expect(xLines[0]?.dataset.stroke).toBe('var(--steel)');
    // The NOW dash ('2 3'), not the order-by marker's ('5 4') — proves this
    // is the NOW line, not a stray order-by marker.
    expect(xLines[0]?.dataset.dash).toBe('2 3');
  });

  it('renders an unlabeled steel NOW reference line at the current month in the production-shaped case (series starts at CURRENT_MONTH)', () => {
    // This IS the real shape: `forecast.months` always opens at "now" for a
    // fleet tile (buildClusterForecastEntries never prepends baseline
    // history the way ForecastChart's `preWindow` rows do), so foundIndex is
    // 0 on every real tile — this fixture is not a contrived edge case.
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
    const nowLine = screen.getByTestId(`refline-x-${CURRENT_MONTH}`);
    expect(nowLine).toBeInTheDocument();
    expect(nowLine.dataset.stroke).toBe('var(--steel)');
  });

  it('also renders the NOW marker when the current month is mid-series', () => {
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

  it('omits the NOW marker when the current month falls outside the visible window', () => {
    const monthsWithoutNow: ForecastMonthPoint[] = [
      { month: shiftMonth(CURRENT_MONTH, 6), consumption: 700, capacity: 1000, utilization: 0.7 },
      { month: shiftMonth(CURRENT_MONTH, 7), consumption: 800, capacity: 1000, utilization: 0.8 },
    ];
    render(
      <ClusterTileChart
        months={monthsWithoutNow}
        thresholds={{ warn: 0.7, crit: 0.9 }}
        orderByDate={null}
      />,
    );
    expect(screen.queryByTestId(/^refline-x-/)).not.toBeInTheDocument();
  });
});
