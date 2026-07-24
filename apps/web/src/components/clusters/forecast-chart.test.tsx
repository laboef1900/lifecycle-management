import type { ForecastResponse } from '@lcm/shared';
import { render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/components/theme/theme-provider';
import { todayIso } from '@/lib/format';

import { ForecastChart } from './forecast-chart';

const currentMonth = todayIso();

/** `'2026-07-01'` + 1 -> `'2026-08-01'` — month-key arithmetic for fixtures. */
function shiftMonth(monthIso: string, delta: number): string {
  const d = new Date(`${monthIso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function renderChart(
  forecast: ForecastResponse,
  { compact = false }: { compact?: boolean } = {},
): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <ForecastChart forecast={forecast} compact={compact} />
    </ThemeProvider>,
  );
}

// Recharts components do heavy SVG rendering we don't need to assert on; replace
// them with minimal pass-through stubs so we can verify props mapping without
// pulling in a full chart canvas.
// The ResponsiveContainer stub renders a fragment, so there is no DOM node to
// hang a data-attribute on — capture the props under test out-of-band instead.
const containerProbe = vi.hoisted(() => ({
  debounce: undefined as number | undefined,
  /**
   * When true the stub withholds `onResize` entirely, reproducing what real
   * recharts does during the debounce window after mount: it calls `onResize`
   * ONLY from its throttled (`leading: false`) ResizeObserver callback, never
   * from the synchronous `getBoundingClientRect()` it performs when attaching
   * the observer.
   */
  withholdOnResize: false,
}));

vi.mock('recharts', async () => {
  const { useEffect } = await import('react');
  const Pass = ({ children }: { children?: React.ReactNode }): React.JSX.Element => <>{children}</>;
  const ResponsiveContainer = ({
    children,
    onResize,
    debounce,
  }: {
    children?: React.ReactNode;
    onResize?: (width: number, height: number) => void;
    debounce?: number;
  }): React.JSX.Element => {
    // Stands in for the first throttled ResizeObserver callback. The stub fires
    // it immediately rather than after `debounce` ms, so real timing is not
    // simulated here — the prop is asserted instead (see the debounce test),
    // and `withholdOnResize` covers the pre-callback window.
    useEffect(() => {
      containerProbe.debounce = debounce;
      if (containerProbe.withholdOnResize) return;
      onResize?.(800, 320);
    }, [onResize, debounce]);
    return <>{children}</>;
  };
  return {
    ResponsiveContainer,
    ComposedChart: ({ data, children }: { data: unknown; children?: React.ReactNode }) => (
      <div
        data-testid="chart"
        data-month-count={(data as unknown[]).length}
        data-rows={JSON.stringify(data)}
      >
        {children}
      </div>
    ),
    CartesianGrid: Pass,
    XAxis: ({ tick }: { tick?: { fill?: string } }): React.JSX.Element => (
      <div data-testid="x-axis" data-tick-fill={tick?.fill ?? ''} />
    ),
    YAxis: ({
      tick,
      label,
      domain,
      ticks,
    }: {
      tick?: { fill?: string };
      label?: { style?: { fill?: string } };
      domain?: [number | string, number | string];
      ticks?: number[];
    }): React.JSX.Element => (
      <div
        data-testid="y-axis"
        data-tick-fill={tick?.fill ?? ''}
        data-label-fill={label?.style?.fill ?? ''}
        data-domain={JSON.stringify(domain ?? null)}
        data-ticks={JSON.stringify(ticks ?? null)}
      />
    ),
    Tooltip: () => null,
    Area: ({ dataKey }: { dataKey: string }) => <div data-testid={`area-${dataKey}`} />,
    Line: ({
      dataKey,
      strokeDasharray,
      connectNulls,
    }: {
      dataKey: string;
      strokeDasharray?: string;
      connectNulls?: boolean;
    }) => (
      <div
        data-testid={`line-${dataKey}`}
        data-dasharray={strokeDasharray ?? ''}
        data-connect-nulls={String(connectNulls ?? '')}
      />
    ),
    LabelList: () => null,
    ReferenceDot: ({
      x,
      y,
      fill,
      label,
    }: {
      x: string;
      y: number;
      fill: string;
      label?: (props: {
        viewBox: { x: number; y: number; width: number; height: number };
      }) => React.ReactNode;
    }): React.JSX.Element => (
      <div data-testid="reference-dot" data-x={x} data-y={y} data-fill={fill}>
        {/* Real recharts passes the dot's pixel bounding box; the mock reuses
            the data-space y as the pixel top and a fixed x of 200 so tests can
            steer vertical placement deterministically. */}
        {label ? label({ viewBox: { x: 200, y, width: 10, height: 10 } }) : null}
      </div>
    ),
    ReferenceLine: ({
      x,
      label,
      stroke,
      strokeDasharray,
    }: {
      x?: string;
      label?: { value?: string };
      stroke?: string;
      strokeDasharray?: string;
    }): React.JSX.Element => (
      <div
        data-testid="reference-line"
        data-x={x}
        data-label={label?.value ?? ''}
        data-stroke={stroke ?? ''}
        data-dash={strokeDasharray ?? ''}
      />
    ),
  };
});

function makeForecast(overrides: Partial<ForecastResponse> = {}): ForecastResponse {
  return {
    fromMonth: '2026-05-01',
    toMonth: '2026-07-01',
    months: [
      { month: '2026-05-01', consumption: 100, capacity: 1000, utilization: 0.1 },
      { month: '2026-06-01', consumption: 150, capacity: 1000, utilization: 0.15 },
      { month: '2026-07-01', consumption: 200, capacity: 1100, utilization: 0.18 },
    ],
    events: [],
    hosts: [],
    applications: [],
    effectiveThresholds: { warn: 0.7, crit: 0.9, source: 'tenant' },
    procurement: { leadTimeWeeks: 8, orderByDate: null, breachMonth: null },
    baselineHistory: [],
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<ForecastResponse['events'][number]> & { id: string },
): ForecastResponse['events'][number] {
  return {
    effectiveDate: '2026-06-15',
    category: 'Growth',
    title: 'Wachstum',
    description: null,
    consumptionDelta: 50,
    capacityDelta: null,
    ...overrides,
  };
}

describe('ForecastChart props mapping', () => {
  // jsdom doesn't recognise SVG namespace elements like <linearGradient> and
  // warns about casing; the warnings don't affect the assertions.
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

  it('renders one month per forecast point with rounded values', () => {
    const forecast = makeForecast();
    renderChart(forecast);

    expect(screen.getByTestId('chart').dataset.monthCount).toBe('3');
    expect(screen.getByTestId('area-consumption')).toBeInTheDocument();
    expect(screen.getByTestId('line-capacity')).toBeInTheDocument();
  });

  it('renders one reference dot per event placed on the consumption point of that month', () => {
    const forecast = makeForecast({
      events: [
        {
          id: 'e1',
          effectiveDate: '2026-06-15',
          category: 'Growth',
          title: 'Wachstum',
          description: null,
          consumptionDelta: 50,
          capacityDelta: null,
        },
        {
          id: 'e2',
          effectiveDate: '2026-07-01',
          category: 'Hardware',
          title: 'HW',
          description: null,
          consumptionDelta: null,
          capacityDelta: 100,
        },
      ],
    });
    renderChart(forecast);

    const dots = screen.getAllByTestId('reference-dot');
    expect(dots).toHaveLength(2);
    expect(dots[0]?.dataset.x).toBe('2026-06-01');
    expect(dots[0]?.dataset.y).toBe('150'); // consumption at June from the data
    expect(dots[1]?.dataset.x).toBe('2026-07-01');
    expect(dots[1]?.dataset.y).toBe('200');

    expect(dots[0]?.dataset.fill).not.toBe(dots[1]?.dataset.fill);
  });

  it('emits per-month warn/crit levels that step with capacity', () => {
    // Capacity steps up at the third month (e.g. +4096 GB added on 2026-07-01),
    // so warn (70%) and crit (90%) must step alongside it instead of staying
    // flat at the maximum capacity for the whole window.
    const forecast = makeForecast({
      months: [
        { month: '2026-05-01', consumption: 3378, capacity: 7680, utilization: 0.44 },
        { month: '2026-06-01', consumption: 3500, capacity: 7680, utilization: 0.456 },
        { month: '2026-07-01', consumption: 3700, capacity: 11776, utilization: 0.314 },
      ],
    });
    renderChart(forecast);

    expect(screen.getByTestId('line-warnLevel')).toBeInTheDocument();
    expect(screen.getByTestId('line-critLevel')).toBeInTheDocument();

    const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
      warnLevel: number;
      critLevel: number;
    }>;
    expect(rows.map((r) => r.warnLevel)).toEqual([
      Math.round(7680 * 0.7),
      Math.round(7680 * 0.7),
      Math.round(11776 * 0.7),
    ]);
    expect(rows.map((r) => r.critLevel)).toEqual([
      Math.round(7680 * 0.9),
      Math.round(7680 * 0.9),
      Math.round(11776 * 0.9),
    ]);
  });

  it('rounds the y-axis domain top and ticks to a uniform step instead of the raw padded ceiling', () => {
    // maxCeiling 7,680 * 1.05 = 8,064 — the exact odd value from the audit
    // finding ("0, 2,500, 5,000, 8,064"). Recharts always appends the literal
    // domain max as an extra tick, so the fix must round the domain top
    // itself (not just pad it) and pass explicit, evenly-spaced ticks.
    const forecast = makeForecast({
      months: [{ month: '2026-05-01', consumption: 3378, capacity: 7680, utilization: 0.44 }],
    });
    renderChart(forecast);

    const yAxis = screen.getByTestId('y-axis');
    const domain = JSON.parse(yAxis.dataset.domain ?? 'null') as [number, number];
    const ticks = JSON.parse(yAxis.dataset.ticks ?? 'null') as number[];

    expect(domain[1]).not.toBe(8064);
    expect(ticks[ticks.length - 1]).toBe(domain[1]);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    // Every interval between consecutive ticks must be identical.
    const steps = new Set(ticks.slice(1).map((t, i) => t - (ticks[i] ?? 0)));
    expect(steps.size).toBe(1);
  });

  it('falls back to an auto domain when there is no capacity data', () => {
    const forecast = makeForecast({
      months: [{ month: '2026-05-01', consumption: 0, capacity: 0, utilization: 0 }],
    });
    renderChart(forecast);

    const yAxis = screen.getByTestId('y-axis');
    expect(yAxis.dataset.domain).toBe('["auto","auto"]');
    expect(yAxis.dataset.ticks).toBe('null');
  });

  it('shows a legend chip only for the capacity direction(s) present among events', () => {
    const consumesOnly = makeForecast({
      events: [
        {
          id: 'e1',
          effectiveDate: '2026-06-01',
          category: 'OpenShift',
          title: 'lab',
          description: null,
          consumptionDelta: 10,
          capacityDelta: null,
        },
      ],
    });
    renderChart(consumesOnly);

    expect(screen.getByText('Actual —')).toBeInTheDocument();
    expect(screen.getByText('Capacity ceiling')).toBeInTheDocument();
    expect(screen.getByText('Consumes capacity')).toBeInTheDocument();
    expect(screen.queryByText('Adds capacity')).not.toBeInTheDocument();
  });

  it('shows both direction chips when events add and consume capacity', () => {
    const forecast = makeForecast({
      events: [
        makeEvent({ id: 'e1', capacityDelta: 100 }),
        makeEvent({ id: 'e2', effectiveDate: '2026-07-01', capacityDelta: null }),
      ],
    });
    renderChart(forecast);

    expect(screen.getByTestId('legend-swatch-event-adds')).toBeInTheDocument();
    expect(screen.getByTestId('legend-swatch-event-consumes')).toBeInTheDocument();
    expect(screen.getByText('Adds capacity')).toBeInTheDocument();
    expect(screen.getByText('Consumes capacity')).toBeInTheDocument();
  });

  it('explains the actual/forecast split, swatches Headroom as a filled area, and lists the measured baseline', () => {
    renderChart(makeForecast());

    // The solid/dashed convention gets its own two entries instead of one
    // ambiguous "Consumption" swatch.
    expect(screen.getByText('Actual —')).toBeInTheDocument();
    expect(screen.getByText('Forecast ⌁')).toBeInTheDocument();
    // The dotted measured-baseline series (rendered whenever there's history)
    // had no legend entry at all before.
    expect(screen.getByText('Measured baseline')).toBeInTheDocument();

    // Headroom is a filled band on the chart, not a line — its swatch must be
    // a filled square, not the dashed-line swatch it wrongly borrowed before.
    const headroomSwatch = screen.getByTestId('legend-swatch-headroom');
    expect(headroomSwatch.className).toContain('rounded-sm');
    // Capacity ceiling stays a genuine dashed line swatch, proving the area
    // swatch is specific to Headroom, not a blanket change.
    const capacitySwatch = screen.getByTestId('legend-swatch-capacity');
    expect(capacitySwatch.className).not.toContain('rounded-sm');
  });

  it('shows the uncertainty-band legend + empirical caption (naming N) only when the band is present', () => {
    // Opt-in: nothing by default.
    const { unmount } = renderChart(makeForecast());
    expect(screen.queryByTestId('legend-swatch-band')).not.toBeInTheDocument();
    expect(screen.queryByTestId('forecast-band-caption')).not.toBeInTheDocument();
    unmount();

    // Present with measured bounds + anchor count → labeled empirical, names N,
    // and states it is not a guarantee (mandatory empirical labeling).
    renderChart(
      makeForecast({
        uncertainty: [{ month: '2026-07-01', low: 0.12, high: 0.24 }],
        uncertaintyAnchorCount: 6,
      }),
    );
    expect(screen.getByTestId('legend-swatch-band')).toBeInTheDocument();
    const caption = screen.getByTestId('forecast-band-caption');
    expect(caption).toHaveTextContent('6 past forecasts');
    expect(caption).toHaveTextContent(/not a guarantee/i);
  });

  it('converts band fractions to GB per month, clamps low at 0, and omits non-forecast months', () => {
    // today is the current month → with months starting this month, index 0 is the
    // anchor and 1..N are forecast months. Bands attach to forecast months only.
    renderChart(
      makeForecast({
        fromMonth: currentMonth,
        months: [
          { month: currentMonth, consumption: 500, capacity: 1000, utilization: 0.5 },
          {
            month: shiftMonth(currentMonth, 1),
            consumption: 520,
            capacity: 1000,
            utilization: 0.52,
          },
          {
            month: shiftMonth(currentMonth, 2),
            consumption: 540,
            capacity: 1000,
            utilization: 0.54,
          },
        ],
        uncertainty: [
          { month: shiftMonth(currentMonth, 1), low: 0.4, high: 0.62 },
          { month: shiftMonth(currentMonth, 2), low: -0.05, high: 0.7 }, // low must clamp to 0
        ],
        uncertaintyAnchorCount: 6,
      }),
    );
    const rows = JSON.parse(
      screen.getByTestId('chart').getAttribute('data-rows') ?? '[]',
    ) as Array<{ month: string; bandRange: [number, number] | null }>;
    const byMonth = new Map(rows.map((r) => [r.month, r.bandRange]));
    // fraction * capacity, rounded.
    expect(byMonth.get(shiftMonth(currentMonth, 1))).toEqual([400, 620]);
    // low clamped at 0; high left to the axis.
    expect(byMonth.get(shiftMonth(currentMonth, 2))).toEqual([0, 700]);
    // The anchor (non-forecast) month carries no band.
    expect(byMonth.get(currentMonth)).toBeNull();
  });

  it('debounces container resize past the LONGEST pane transition so it settles in one window', () => {
    // At lg+ the scenario pane is a flex sibling whose width animates 0->340px,
    // resizing this container every frame. Without a debounce each frame
    // re-renders the whole ComposedChart plus the pixel-space event-label
    // collision planner. Recharts throttles with `leading: false`, so the
    // debounce must exceed the pane's LONGEST transition (`cluster-panel.tsx`
    // ENTER_TRANSITION = 280 ms) for the animation to settle inside a single
    // throttle window; at 280 or below the enter fires once mid-flight at an
    // intermediate width and again on settle.
    containerProbe.debounce = undefined;
    renderChart(makeForecast());

    expect(containerProbe.debounce).toBeGreaterThan(280);
  });

  it('measures the chart on mount instead of waiting for the debounced onResize', () => {
    // Regression guard for the debounce above. recharts calls `onResize` ONLY
    // from its throttled (leading:false) ResizeObserver callback, so the first
    // one lands a full debounce window after mount. If the component waited for
    // it, `chartWidth` would stay null for that window and
    // planEventLabelOffsets would skip its plot-edge clamp — every panel open
    // would show unplanned event labels that then jump into place.
    const forecast = makeForecast({
      // A single event in the FIRST month: unmeasured its offset is 0, measured
      // the planner pushes it right so the box clears the plot's left edge.
      events: [makeEvent({ id: 'edge', effectiveDate: '2026-05-10' })],
    });
    const boxX = (): string | null =>
      screen.getAllByTestId('reference-dot')[0]?.querySelector('rect')?.getAttribute('x') ?? null;

    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    const measurable = (width: number): DOMRect =>
      ({ width, height: 320, top: 0, left: 0, right: width, bottom: 320, x: 0, y: 0 }) as DOMRect;

    try {
      // 1. onResize withheld (we are inside the debounce window) but the DOM is
      //    measurable — this is the path the fix adds.
      containerProbe.withholdOnResize = true;
      rectSpy.mockReturnValue(measurable(800));
      const { unmount: unmountSeeded } = renderChart(forecast);
      const seeded = boxX();
      unmountSeeded();

      // 2. Same, but nothing can be measured (zero-width container), so the
      //    planner genuinely has no width to work with.
      rectSpy.mockReturnValue(measurable(0));
      const { unmount: unmountBlind } = renderChart(forecast);
      const unmeasured = boxX();
      unmountBlind();

      // 3. The debounced onResize finally fires with the same 800px width.
      containerProbe.withholdOnResize = false;
      rectSpy.mockReturnValue(measurable(0));
      renderChart(forecast);
      const afterOnResize = boxX();

      // The mount seed must already produce the planned layout...
      expect(seeded).not.toBeNull();
      expect(seeded).toBe(afterOnResize);
      // ...and it must actually be doing something: without a measurable width
      // the same render lays the label out differently.
      expect(seeded).not.toBe(unmeasured);
    } finally {
      containerProbe.withholdOnResize = false;
      rectSpy.mockRestore();
    }
  });

  it('fills axis tick text with fg-subtle, not the axis line color (dark-theme contrast fix)', () => {
    // Recharts paints tick text from the axis `stroke` by default; `colors.axis`
    // (`--chart-axis`) is tuned as a ~1.4:1 line color in dark mode, unreadable
    // as text. Tick text must use the separate `--fg-subtle` text token while
    // the axis line itself keeps `colors.axis` via `stroke`.
    const forecast = makeForecast();
    renderChart(forecast);

    expect(screen.getByTestId('x-axis').dataset.tickFill).toBe('var(--fg-subtle)');
    expect(screen.getByTestId('y-axis').dataset.tickFill).toBe('var(--fg-subtle)');
    expect(screen.getByTestId('y-axis').dataset.labelFill).toBe('var(--fg-subtle)');
  });

  it('labels each event dot with vertical text colored by capacity direction', () => {
    const forecast = makeForecast({
      events: [
        makeEvent({ id: 'e1', effectiveDate: '2026-06-15', capacityDelta: 100 }),
        makeEvent({
          id: 'e2',
          effectiveDate: '2026-07-01',
          title: 'HW Tausch',
          capacityDelta: -50,
        }),
      ],
    });
    renderChart(forecast);

    const dots = screen.getAllByTestId('reference-dot');
    const juneDot = dots.find((d) => d.dataset.x === '2026-06-01');
    const julyDot = dots.find((d) => d.dataset.x === '2026-07-01');
    if (!juneDot || !julyDot) throw new Error('expected dots for June and July');

    const addsLabel = within(juneDot).getByText('Wachstum');
    const consumesLabel = within(julyDot).getByText('HW Tausch');

    // Vertical orientation, matching the -90° y-axis label convention.
    expect(addsLabel.getAttribute('transform')).toMatch(/rotate\(-90/);
    expect(consumesLabel.getAttribute('transform')).toMatch(/rotate\(-90/);

    // Label colour comes from the event's capacityDelta and matches its own dot.
    expect(addsLabel.getAttribute('fill')).toBe(juneDot.dataset.fill);
    expect(consumesLabel.getAttribute('fill')).toBe(julyDot.dataset.fill);
    expect(addsLabel.getAttribute('fill')).not.toBe(consumesLabel.getAttribute('fill'));
  });

  it('wraps the label in a category-coloured box with a leader line from the dot', () => {
    const forecast = makeForecast({ events: [makeEvent({ id: 'e1' })] });
    renderChart(forecast);

    const dot = screen.getAllByTestId('reference-dot')[0];
    if (!dot) throw new Error('expected a reference dot');
    const box = dot.querySelector('rect');
    const leader = dot.querySelector('line');
    const label = within(dot).getByText('Wachstum');
    const categoryColor = label.getAttribute('fill');

    // The mock passes viewBox {x: 200, y: 150, width: 10, height: 10} (June
    // consumption is 150): dot centre (205, 155), 'Wachstum' -> 20x58 box below.
    expect(box?.getAttribute('stroke')).toBe(categoryColor);
    expect(box?.getAttribute('fill')).toBe('var(--card)');
    expect(box?.getAttribute('x')).toBe('195');
    expect(box?.getAttribute('y')).toBe('168');
    expect(box?.getAttribute('width')).toBe('20');
    expect(box?.getAttribute('height')).toBe('58');
    expect(leader?.getAttribute('stroke')).toBe(categoryColor);
    expect(leader?.getAttribute('x1')).toBe('205');
    expect(leader?.getAttribute('y1')).toBe('155');
    expect(leader?.getAttribute('x2')).toBe('205');
    expect(leader?.getAttribute('y2')).toBe('168'); // meets the box top
  });

  it('flips the label above the dot when there is no room below', () => {
    const forecast = makeForecast({
      months: [
        { month: '2026-05-01', consumption: 100, capacity: 1000, utilization: 0.1 },
        { month: '2026-06-01', consumption: 270, capacity: 1000, utilization: 0.27 },
        { month: '2026-07-01', consumption: 200, capacity: 1100, utilization: 0.18 },
      ],
      events: [makeEvent({ id: 'e1', title: 'Umzug' })],
    });
    renderChart(forecast);

    const dot = screen.getAllByTestId('reference-dot')[0];
    if (!dot) throw new Error('expected a reference dot');
    const box = dot.querySelector('rect');
    const leader = dot.querySelector('line');

    // viewBox y 270 leaves 10px below the dot ('Umzug' needs 48): the 20x40
    // box flips above, the leader running upwards from the dot centre.
    expect(box?.getAttribute('y')).toBe('222');
    expect(leader?.getAttribute('y1')).toBe('275');
    expect(leader?.getAttribute('y2')).toBe('262'); // meets the box bottom
  });

  it('spreads same-month labels into columns symmetric around the dot', () => {
    const forecast = makeForecast({
      events: [
        makeEvent({ id: 'e1', effectiveDate: '2026-06-05', title: 'Erstes' }),
        makeEvent({
          id: 'e2',
          effectiveDate: '2026-06-20',
          category: 'OpenShift',
          title: 'Zweites',
        }),
      ],
    });
    renderChart(forecast);

    // Both dots sit at x 205 in the mock; the plan shifts the labels ±12px so
    // the 20px boxes stay clear of each other, centred on the dot.
    expect(screen.getByText('Erstes').getAttribute('x')).toBe('193');
    expect(screen.getByText('Zweites').getAttribute('x')).toBe('217');
  });

  it('truncates long titles to 17 glyphs plus an ellipsis', () => {
    const longTitle = 'A very long event title that overflows the chart';
    const forecast = makeForecast({ events: [makeEvent({ id: 'e1', title: longTitle })] });
    renderChart(forecast);

    expect(screen.queryByText(longTitle)).not.toBeInTheDocument();
    expect(screen.getByText('A very long event…')).toBeInTheDocument();
  });

  it('uses a narrower box and tighter truncation limit in compact mode', () => {
    const forecast = makeForecast({
      events: [makeEvent({ id: 'e1', title: 'Kapazitätserweiterung' })],
    });
    renderChart(forecast, { compact: true });

    expect(screen.getByText('Kapazitätse…')).toBeInTheDocument();
    const dot = screen.getAllByTestId('reference-dot')[0];
    expect(dot?.querySelector('rect')?.getAttribute('width')).toBe('19');
  });
});

describe('ForecastChart host EOL reference line', () => {
  // These fixtures use fixed 2026-05..07 months and December/June host dates
  // unrelated to "today" — pin the clock outside that range so the NOW marker
  // (todayIso()-driven, see the 'ForecastChart NOW marker' describe below)
  // doesn't add a second reference-line and break the exact-count assertions
  // here, which are about EOL, not NOW.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders an EOL reference line at the month of the earliest projected host decommission', () => {
    const forecast = makeForecast({
      months: [
        { month: '2026-05-01', consumption: 100, capacity: 1000, utilization: 0.1 },
        { month: '2026-06-01', consumption: 150, capacity: 1000, utilization: 0.15 },
        { month: '2026-07-01', consumption: 200, capacity: 1000, utilization: 0.2 },
      ],
      hosts: [
        {
          id: 'h1',
          name: 'host-late',
          projectedDecommissionAt: '2026-12-20',
          contributions: [],
        },
        {
          id: 'h2',
          name: 'host-early',
          projectedDecommissionAt: '2026-06-15',
          contributions: [],
        },
        {
          id: 'h3',
          name: 'host-no-eol',
          projectedDecommissionAt: null,
          contributions: [],
        },
      ],
    });
    renderChart(forecast);

    const lines = screen.getAllByTestId('reference-line');
    expect(lines).toHaveLength(1);
    // Earliest EOL is 2026-06-15, snapped to month-start 2026-06-01 (which is
    // inside the visible window).
    expect(lines[0]?.dataset.x).toBe('2026-06-01');
    expect(lines[0]?.dataset.label).toBe('EOL: host-early');
  });

  it('does not render an EOL line when no host has a projected decommission date', () => {
    const forecast = makeForecast({
      hosts: [
        { id: 'h1', name: 'h1', projectedDecommissionAt: null, contributions: [] },
        { id: 'h2', name: 'h2', contributions: [] },
      ],
    });
    renderChart(forecast);

    expect(screen.queryByTestId('reference-line')).not.toBeInTheDocument();
  });

  it('does not render an EOL line when the earliest EOL falls outside the visible window', () => {
    const forecast = makeForecast({
      // visible window is May–July 2026
      hosts: [
        {
          id: 'h1',
          name: 'future-host',
          projectedDecommissionAt: '2027-04-01',
          contributions: [],
        },
      ],
    });
    renderChart(forecast);

    expect(screen.queryByTestId('reference-line')).not.toBeInTheDocument();
  });
});

describe('ForecastChart accessible label (#243 Part B)', () => {
  it('exposes a rich aria-label with window length, breach month, thresholds, and ceiling', () => {
    const forecast = makeForecast({
      months: [
        { month: '2026-05-01', consumption: 700, capacity: 1000, utilization: 0.7 },
        { month: '2026-06-01', consumption: 750, capacity: 1000, utilization: 0.75 },
        { month: '2026-07-01', consumption: 800, capacity: 1000, utilization: 0.8 },
      ],
      effectiveThresholds: { warn: 0.7, crit: 0.9, source: 'tenant' },
    });
    renderChart(forecast);

    const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('3-month capacity forecast chart');
    expect(label).toContain('Warn breach about May 26');
    expect(label).toContain('Warn threshold 70 percent');
    expect(label).toContain('Critical threshold 90 percent');
    expect(label).toContain('Capacity ceiling 1,000 GB');
  });

  it('reports no breach in the aria-label when no month reaches warn', () => {
    const forecast = makeForecast({
      months: [{ month: '2026-05-01', consumption: 100, capacity: 1000, utilization: 0.1 }],
    });
    renderChart(forecast);

    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      'No breach within the window',
    );
  });
});

describe('ForecastChart actual/forecast split', () => {
  it('splits consumption into a solid actual line and a dashed forecast line anchored at the current month', () => {
    const forecast = makeForecast({
      months: [
        { month: currentMonth, consumption: 500, capacity: 1000, utilization: 0.5 },
        { month: shiftMonth(currentMonth, 1), consumption: 600, capacity: 1000, utilization: 0.6 },
      ],
    });
    renderChart(forecast);

    const actualLine = screen.getByTestId('line-actual');
    const forecastLine = screen.getByTestId('line-forecast');
    expect(actualLine.dataset.dasharray).toBe('');
    expect(forecastLine.dataset.dasharray).not.toBe('');

    const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
      month: string;
      actual: number | null;
      forecast: number | null;
    }>;
    expect(rows[0]).toMatchObject({ month: currentMonth, actual: 500, forecast: 500 });
    expect(rows[1]).toMatchObject({
      month: shiftMonth(currentMonth, 1),
      actual: null,
      forecast: 600,
    });
  });
});

describe('ForecastChart NOW marker', () => {
  it('renders a labeled steel NOW reference line at the current month when it is not the first plotted point', () => {
    const forecast = makeForecast({
      months: [
        { month: shiftMonth(currentMonth, -1), consumption: 400, capacity: 1000, utilization: 0.4 },
        { month: currentMonth, consumption: 500, capacity: 1000, utilization: 0.5 },
        { month: shiftMonth(currentMonth, 1), consumption: 600, capacity: 1000, utilization: 0.6 },
      ],
    });
    renderChart(forecast);

    const nowLine = screen
      .getAllByTestId('reference-line')
      .find((el) => el.dataset.x === currentMonth);
    expect(nowLine).toBeDefined();
    expect(nowLine?.dataset.label).toBe('NOW');
    expect(nowLine?.dataset.stroke).toBe('var(--steel)');
    expect(nowLine?.dataset.dash).not.toBe('');
  });

  it('omits the marker when the window opens at the current month (it would sit on the y-axis)', () => {
    const forecast = makeForecast({
      months: [
        { month: currentMonth, consumption: 500, capacity: 1000, utilization: 0.5 },
        { month: shiftMonth(currentMonth, 1), consumption: 600, capacity: 1000, utilization: 0.6 },
      ],
    });
    renderChart(forecast);

    expect(screen.queryByTestId('reference-line')).not.toBeInTheDocument();
  });

  it('omits the marker when the current month falls outside the visible window', () => {
    const forecast = makeForecast({
      months: [
        { month: shiftMonth(currentMonth, 6), consumption: 500, capacity: 1000, utilization: 0.5 },
        { month: shiftMonth(currentMonth, 7), consumption: 600, capacity: 1000, utilization: 0.6 },
      ],
    });
    renderChart(forecast);

    expect(screen.queryByTestId('reference-line')).not.toBeInTheDocument();
  });
});

describe('ForecastChart scenario ghost', () => {
  function baselineAndScenario(): { baseline: ForecastResponse; scenario: ForecastResponse } {
    const baseline = makeForecast({
      months: [
        { month: currentMonth, consumption: 500, capacity: 1000, utilization: 0.5 },
        { month: shiftMonth(currentMonth, 1), consumption: 600, capacity: 1000, utilization: 0.6 },
      ],
    });
    const scenario = makeForecast({
      months: [
        { month: currentMonth, consumption: 700, capacity: 1000, utilization: 0.7 },
        { month: shiftMonth(currentMonth, 1), consumption: 850, capacity: 1000, utilization: 0.85 },
      ],
    });
    return { baseline, scenario };
  }

  it('makes the scenario series the primary actual/forecast line and keeps baseline consumption as a muted dashed ghost', () => {
    const { baseline, scenario } = baselineAndScenario();
    render(
      <ThemeProvider>
        <ForecastChart
          forecast={baseline}
          scenario={{ label: 'Lose 1 host', forecast: scenario }}
        />
      </ThemeProvider>,
    );

    const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
      month: string;
      actual: number | null;
      forecast: number | null;
      baselineConsumption: number | null;
    }>;
    // Primary actual/forecast now tracks the scenario, not the baseline.
    expect(rows[0]).toMatchObject({ month: currentMonth, actual: 700, forecast: 700 });
    expect(rows[1]).toMatchObject({
      month: shiftMonth(currentMonth, 1),
      actual: null,
      forecast: 850,
    });
    // The baseline consumption survives as a ghost field for every row.
    expect(rows[0]?.baselineConsumption).toBe(500);
    expect(rows[1]?.baselineConsumption).toBe(600);

    const ghostLine = screen.getByTestId('line-baselineConsumption');
    expect(ghostLine).toBeInTheDocument();
    expect(ghostLine.dataset.dasharray).not.toBe('');
    expect(screen.getByText(/was: baseline/i)).toBeInTheDocument();
  });

  it('omits the baseline ghost field and legend entry when no scenario is active', () => {
    renderChart(makeForecast());

    expect(screen.queryByTestId('line-baselineConsumption')).not.toBeInTheDocument();
    expect(screen.queryByText(/was: baseline/i)).not.toBeInTheDocument();
  });

  it('renders the scenarioDeltaLabel under the legend when provided', () => {
    const { baseline, scenario } = baselineAndScenario();
    render(
      <ThemeProvider>
        <ForecastChart
          forecast={baseline}
          scenario={{ label: 'Lose 1 host', forecast: scenario }}
          scenarioDeltaLabel="▲ warn 5 mo earlier (was ≈ Apr 2027)"
        />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('scenario-delta-label')).toHaveTextContent(
      '▲ warn 5 mo earlier (was ≈ Apr 2027)',
    );
  });

  it('omits the delta label element when scenarioDeltaLabel is not provided', () => {
    renderChart(makeForecast());

    expect(screen.queryByTestId('scenario-delta-label')).not.toBeInTheDocument();
  });

  it('notes an active what-if scenario in the aria-label', () => {
    const { baseline, scenario } = baselineAndScenario();
    render(
      <ThemeProvider>
        <ForecastChart
          forecast={baseline}
          scenario={{ label: 'Lose 1 host', forecast: scenario }}
        />
      </ThemeProvider>,
    );

    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      'A what-if scenario is active',
    );
  });

  it('does not mention a scenario in the aria-label when none is active', () => {
    renderChart(makeForecast());

    expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('what-if scenario');
  });
});

describe('<ForecastChart> baseline history (#177)', () => {
  it('renders measured baselines and extends the axis back to the oldest one', () => {
    renderChart(
      makeForecast({
        baselineHistory: [
          {
            capturedAt: '2026-03-01',
            source: 'manual',
            consumption: 60,
            capacity: 1000,
            utilization: 0.06,
          },
          {
            capturedAt: '2026-05-01',
            source: 'vsphere',
            consumption: 100,
            capacity: 1000,
            utilization: 0.1,
          },
        ],
      }),
    );

    // March predates the forecast window (which opens at the newest baseline), so
    // without the leading rows it would be invisible — the exact problem #172 exists
    // to fix.
    expect(screen.getByTestId('chart').dataset.monthCount).toBe('4');

    const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
      month: string;
      measured: number | null;
    }>;
    expect(rows.map((r) => r.month)).toEqual([
      '2026-03-01',
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
    ]);
    expect(rows.map((r) => r.measured)).toEqual([60, 100, null, null]);
  });

  it('breaks the measured line across a missing month instead of interpolating it', () => {
    renderChart(
      makeForecast({
        baselineHistory: [
          {
            capturedAt: '2026-05-01',
            source: 'vsphere',
            consumption: 100,
            capacity: 1000,
            utilization: 0.1,
          },
          // June missing — a snapshot that could not be taken.
          {
            capturedAt: '2026-07-01',
            source: 'vsphere',
            consumption: 200,
            capacity: 1100,
            utilization: 0.18,
          },
        ],
      }),
    );

    const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
      month: string;
      measured: number | null;
    }>;
    // June is null, NOT 0 — "we don't know", not "nothing was used".
    expect(rows.find((r) => r.month === '2026-06-01')?.measured).toBeNull();

    // ...and the line must not bridge it. Connecting May to July would smooth a
    // missing measurement into a trend nobody recorded, on the series that drives
    // hardware purchasing.
    expect(screen.getByTestId('line-measured').dataset.connectNulls).toBe('false');
  });
});
