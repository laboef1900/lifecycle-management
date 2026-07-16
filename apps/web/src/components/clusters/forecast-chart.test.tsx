import type { ForecastResponse } from '@lcm/shared';
import { render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/components/theme/theme-provider';

import { ForecastChart } from './forecast-chart';

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
vi.mock('recharts', async () => {
  const { useEffect } = await import('react');
  const Pass = ({ children }: { children?: React.ReactNode }): React.JSX.Element => <>{children}</>;
  const ResponsiveContainer = ({
    children,
    onResize,
  }: {
    children?: React.ReactNode;
    onResize?: (width: number, height: number) => void;
  }): React.JSX.Element => {
    // Simulate the initial measurement recharts performs on mount.
    useEffect(() => {
      onResize?.(800, 320);
    }, [onResize]);
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
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Area: ({ dataKey }: { dataKey: string }) => <div data-testid={`area-${dataKey}`} />,
    Line: ({ dataKey }: { dataKey: string }) => <div data-testid={`line-${dataKey}`} />,
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
    }: {
      x?: string;
      label?: { value?: string };
    }): React.JSX.Element => (
      <div data-testid="reference-line" data-x={x} data-label={label?.value ?? ''} />
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

  it('shows category legend chips for the event categories present', () => {
    const forecast = makeForecast({
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
    renderChart(forecast);

    expect(screen.getByText('Consumption')).toBeInTheDocument();
    expect(screen.getByText('Capacity ceiling')).toBeInTheDocument();
    expect(screen.getByText('OpenShift')).toBeInTheDocument();
  });

  it('exposes the chart as a labelled image', () => {
    const forecast = makeForecast();
    renderChart(forecast);

    expect(screen.getByRole('img', { name: 'Capacity forecast chart' })).toBeInTheDocument();
  });

  it('labels each event dot with vertical text in the category colour', () => {
    const forecast = makeForecast({
      events: [
        makeEvent({ id: 'e1', effectiveDate: '2026-06-15', category: 'Growth' }),
        makeEvent({
          id: 'e2',
          effectiveDate: '2026-07-01',
          category: 'Hardware',
          title: 'HW Tausch',
        }),
      ],
    });
    renderChart(forecast);

    const dots = screen.getAllByTestId('reference-dot');
    const juneDot = dots.find((d) => d.dataset.x === '2026-06-01');
    const julyDot = dots.find((d) => d.dataset.x === '2026-07-01');
    if (!juneDot || !julyDot) throw new Error('expected dots for June and July');

    const growthLabel = within(juneDot).getByText('Wachstum');
    const hardwareLabel = within(julyDot).getByText('HW Tausch');

    // Vertical orientation, matching the -90° y-axis label convention.
    expect(growthLabel.getAttribute('transform')).toMatch(/rotate\(-90/);
    expect(hardwareLabel.getAttribute('transform')).toMatch(/rotate\(-90/);

    // Label colour comes from the event category and matches its own dot.
    expect(growthLabel.getAttribute('fill')).toBe(juneDot.dataset.fill);
    expect(hardwareLabel.getAttribute('fill')).toBe(julyDot.dataset.fill);
    expect(growthLabel.getAttribute('fill')).not.toBe(hardwareLabel.getAttribute('fill'));
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
