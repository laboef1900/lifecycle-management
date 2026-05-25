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
    ReferenceDot: ({ x, y, fill }: { x: string; y: number; fill: string }): React.JSX.Element => (
      <div data-testid="reference-dot" data-x={x} data-y={y} data-fill={fill} />
    ),
    ReferenceLine: () => null,
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
});
