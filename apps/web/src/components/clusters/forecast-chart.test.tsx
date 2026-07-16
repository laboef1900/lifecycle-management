import type { ForecastResponse } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/components/theme/theme-provider';

import { ForecastChart } from './forecast-chart';

function renderChart(forecast: ForecastResponse): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <ForecastChart forecast={forecast} />
    </ThemeProvider>,
  );
}

// Recharts components do heavy SVG rendering we don't need to assert on; replace
// them with minimal pass-through stubs so we can verify props mapping without
// pulling in a full chart canvas.
vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }): React.JSX.Element => <>{children}</>;
  return {
    ResponsiveContainer: Pass,
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      label?: (props: any) => React.ReactNode;
    }): React.JSX.Element => (
      <div data-testid="reference-dot" data-x={x} data-y={y} data-fill={fill}>
        {typeof label === 'function'
          ? label({ viewBox: { x: 0, y: 0, width: 10, height: 10 } })
          : null}
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
          category: 'growth',
          title: 'Wachstum',
          description: null,
          consumptionDelta: 50,
          capacityDelta: null,
        },
        {
          id: 'e2',
          effectiveDate: '2026-07-01',
          category: 'hardware_change',
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
          category: 'openshift',
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

  it('labels each event dot with vertical text of the event name, coloured by category', () => {
    const forecast = makeForecast({
      events: [
        {
          id: 'e1',
          effectiveDate: '2026-06-15',
          category: 'growth',
          title: 'Wachstum',
          description: null,
          consumptionDelta: 50,
          capacityDelta: null,
        },
        {
          id: 'e2',
          effectiveDate: '2026-07-01',
          category: 'hardware_change',
          title: 'HW Tausch',
          description: null,
          consumptionDelta: null,
          capacityDelta: 100,
        },
      ],
    });
    renderChart(forecast);

    const growthLabel = screen.getByText('Wachstum');
    const hardwareLabel = screen.getByText('HW Tausch');

    // Vertical orientation (matches the -90° y-axis label convention).
    expect(growthLabel.getAttribute('transform')).toMatch(/rotate\(-90/);
    expect(hardwareLabel.getAttribute('transform')).toMatch(/rotate\(-90/);

    // Colour comes from the event category, so the two categories differ and
    // each label matches its own dot's fill.
    const dots = screen.getAllByTestId('reference-dot');
    expect(growthLabel.getAttribute('fill')).toBe(dots[0]?.dataset.fill);
    expect(hardwareLabel.getAttribute('fill')).toBe(dots[1]?.dataset.fill);
    expect(growthLabel.getAttribute('fill')).not.toBe(hardwareLabel.getAttribute('fill'));
  });

  it('wraps each label in a category-coloured box with a leader line to the dot', () => {
    const forecast = makeForecast({
      events: [
        {
          id: 'e1',
          effectiveDate: '2026-06-15',
          category: 'growth',
          title: 'Wachstum',
          description: null,
          consumptionDelta: 50,
          capacityDelta: null,
        },
      ],
    });
    renderChart(forecast);

    const dot = screen.getAllByTestId('reference-dot')[0];
    const box = dot?.querySelector('rect');
    const leader = dot?.querySelector('line');
    const label = screen.getByText('Wachstum');
    const categoryColor = label.getAttribute('fill');

    // Box drawn in the category colour, filled with the card background so the
    // text stays readable over the chart area.
    expect(box).not.toBeNull();
    expect(box?.getAttribute('stroke')).toBe(categoryColor);
    expect(box?.getAttribute('fill')).toBe('var(--card)');

    // Leader line points from the dot (viewBox centre) down to the box top, in
    // the category colour.
    expect(leader).not.toBeNull();
    expect(leader?.getAttribute('stroke')).toBe(categoryColor);
    const boxTop = Number(box?.getAttribute('y'));
    const leaderStartY = Number(leader?.getAttribute('y1'));
    const leaderEndY = Number(leader?.getAttribute('y2'));
    // Label sits below the datapoint: the leader ends lower (larger y) than it
    // starts, and meets the top of the box.
    expect(leaderEndY).toBeGreaterThan(leaderStartY);
    expect(leaderEndY).toBe(boxTop);
  });

  it('truncates long event titles in the vertical label', () => {
    const longTitle = 'A very long event title that overflows the chart';
    const forecast = makeForecast({
      events: [
        {
          id: 'e1',
          effectiveDate: '2026-06-15',
          category: 'note',
          title: longTitle,
          description: null,
          consumptionDelta: null,
          capacityDelta: null,
        },
      ],
    });
    renderChart(forecast);

    expect(screen.queryByText(longTitle)).not.toBeInTheDocument();
    const label = screen.getByText(/…$/);
    expect(label.textContent?.length).toBeLessThan(longTitle.length);
    expect(label.textContent?.startsWith('A very long')).toBe(true);
  });

  it('spreads same-month event labels into separate columns so they do not stack', () => {
    const forecast = makeForecast({
      events: [
        {
          id: 'e1',
          effectiveDate: '2026-06-05',
          category: 'growth',
          title: 'Erstes',
          description: null,
          consumptionDelta: 10,
          capacityDelta: null,
        },
        {
          id: 'e2',
          effectiveDate: '2026-06-20',
          category: 'openshift',
          title: 'Zweites',
          description: null,
          consumptionDelta: 20,
          capacityDelta: null,
        },
      ],
    });
    renderChart(forecast);

    const first = screen.getByText('Erstes');
    const second = screen.getByText('Zweites');
    // Both dots land in June, but their labels get distinct x positions.
    expect(first.getAttribute('x')).not.toBe(second.getAttribute('x'));
  });
});
