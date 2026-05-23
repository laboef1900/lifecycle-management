# Forecast Legibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make capacity headroom and runway-to-breach the primary visual story across Overview, Clusters list, and Cluster detail.

**Architecture:** Add two presentational primitives (`UtilizationGauge`, `RunwayPill`) and one pure helper module (`forecast-summary.ts`). Existing charts gain a forced-to-ceiling Y-domain, a stacked headroom band, and labeled 70%/90% reference lines. The KPI strip on `/` swaps Worst-cluster for a Runway tile. The Clusters table drops its sparkline + Actions columns and gains a Runway column with whole-row navigation.

**Tech Stack:** React 19 + TypeScript, Vite, Tailwind v4, Recharts, TanStack Router/Query, Vitest + Testing Library, Playwright (golden-path e2e).

**Spec:** [`docs/superpowers/specs/2026-05-23-forecast-legibility-design.md`](../specs/2026-05-23-forecast-legibility-design.md)

---

## File map

**New files**

- `apps/web/src/lib/forecast-summary.ts` — pure `runwayToWarn()` + `fleetRunwayToWarn()`. Returns `{ months: number | null, alreadyBreached: 'warn' | 'crit' | false }`.
- `apps/web/src/__tests__/forecast-summary.test.ts` — unit tests (lives alongside `aggregate-fleet.test.ts`).
- `apps/web/src/components/ui/utilization-gauge.tsx` — circular SVG gauge, sizes `sm | md | lg`.
- `apps/web/src/components/ui/utilization-gauge.test.tsx`.
- `apps/web/src/components/ui/runway-pill.tsx` — pill rendering months-to-warn + already-breached states.
- `apps/web/src/components/ui/runway-pill.test.tsx`.

**Modified files**

- `apps/web/src/components/overview/cluster-tile.tsx` — drop sparkline; render gauge + runway pill.
- `apps/web/src/components/clusters/cluster-table.tsx` — drop sparkline + Actions columns; add Runway column; whole-row link.
- `apps/web/src/components/clusters/cluster-table.test.tsx` — drop sparkline mock; cover Runway column + row navigation.
- `apps/web/src/components/clusters/forecast-chart.tsx` — Y-domain to ceiling, headroom band (stacked Area), labeled reference lines, headroom in tooltip.
- `apps/web/src/components/overview/fleet-capacity-chart.tsx` — Y-domain to ceiling, headroom band (stacked Area), labeled reference lines, headroom in tooltip + legend.
- `apps/web/src/components/clusters/utilization-panel.tsx` — label the 70%/90% reference lines at right edge.
- `apps/web/src/routes/index.tsx` — swap Worst-cluster KPI for Runway KPI; wire fleet runway.
- `apps/web/src/routes/clusters.$id.tsx` — new 3-up KPI strip below title; remove standalone "Current utilization" pill.
- `apps/web/tests/e2e/golden.spec.ts` (extends existing) — gauge + runway assertions on `/`, KPI strip on `/clusters/:id`, runway column + row click on `/clusters`.

**Deleted files**

- `apps/web/src/components/sparkline.tsx` (verified two consumers, both being rewritten).
- `apps/web/src/components/clusters/cluster-sparkline-cell.tsx` (column dropped).

---

## Task 1: Pure helper — `forecast-summary.ts`

**Files:**

- Create: `apps/web/src/lib/forecast-summary.ts`
- Create test: `apps/web/src/__tests__/forecast-summary.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/forecast-summary.test.ts`:

```ts
import type { ForecastMonthPoint } from '@lcm/shared';
import { describe, expect, it } from 'vitest';

import { fleetRunwayToWarn, runwayToWarn } from '../lib/forecast-summary';

const point = (month: string, consumption: number, capacity: number): ForecastMonthPoint => ({
  month,
  consumption,
  capacity,
  utilization: capacity > 0 ? consumption / capacity : 0,
});

describe('runwayToWarn', () => {
  it('returns null months + no breach when forecast stays below 70%', () => {
    const months = [point('2026-05-01', 100, 1000), point('2026-06-01', 200, 1000)];
    expect(runwayToWarn(months)).toEqual({ months: null, alreadyBreached: false });
  });

  it('returns the index of the first month that crosses 70%', () => {
    const months = [
      point('2026-05-01', 500, 1000), // 50%
      point('2026-06-01', 600, 1000), // 60%
      point('2026-07-01', 720, 1000), // 72%
      point('2026-08-01', 800, 1000), // 80%
    ];
    expect(runwayToWarn(months)).toEqual({ months: 2, alreadyBreached: false });
  });

  it('reports already-breached warn when first month is >= 70%', () => {
    const months = [point('2026-05-01', 750, 1000), point('2026-06-01', 800, 1000)];
    expect(runwayToWarn(months)).toEqual({ months: 0, alreadyBreached: 'warn' });
  });

  it('reports already-breached crit when first month is >= 90%', () => {
    const months = [point('2026-05-01', 950, 1000)];
    expect(runwayToWarn(months)).toEqual({ months: 0, alreadyBreached: 'crit' });
  });

  it('treats zero-capacity months as null and skips them when scanning', () => {
    const months = [
      point('2026-05-01', 0, 0),
      point('2026-06-01', 800, 1000), // 80%, the first non-zero month breaches
    ];
    expect(runwayToWarn(months)).toEqual({ months: 1, alreadyBreached: false });
  });

  it('returns null months + no breach for an empty forecast', () => {
    expect(runwayToWarn([])).toEqual({ months: null, alreadyBreached: false });
  });
});

describe('fleetRunwayToWarn', () => {
  it('aggregates consumption + capacity across series before scanning', () => {
    const a = [point('2026-05-01', 300, 1000), point('2026-06-01', 400, 1000)]; // 30%, 40%
    const b = [point('2026-05-01', 400, 1000), point('2026-06-01', 400, 1000)]; // 40%, 40%
    // Fleet: 700/2000=35%, 800/2000=40% — no breach
    expect(fleetRunwayToWarn([a, b])).toEqual({ months: null, alreadyBreached: false });
  });

  it('detects fleet breach even when individual clusters stay below 70%', () => {
    const a = [point('2026-05-01', 650, 1000)]; // 65%
    const b = [point('2026-05-01', 700, 1000)]; // 70% (warn)
    // Fleet: 1350/2000 = 67.5% — still ok
    expect(fleetRunwayToWarn([a, b])).toEqual({ months: null, alreadyBreached: false });
    const c = [point('2026-05-01', 800, 1000)]; // 80%
    // Fleet a+c: 1450/2000 = 72.5% — breach in month 0
    expect(fleetRunwayToWarn([a, c])).toEqual({ months: 0, alreadyBreached: 'warn' });
  });

  it('returns null for empty input', () => {
    expect(fleetRunwayToWarn([])).toEqual({ months: null, alreadyBreached: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/web test -- forecast-summary`
Expected: FAIL — cannot resolve `'../lib/forecast-summary'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/forecast-summary.ts`:

```ts
import type { ForecastMonthPoint } from '@lcm/shared';

export const WARN_THRESHOLD = 0.7;
export const CRIT_THRESHOLD = 0.9;

export interface RunwaySummary {
  /** Index of first month at or above WARN_THRESHOLD, else null. */
  months: number | null;
  /** First month's status when months === 0 (or false if no breach there). */
  alreadyBreached: 'warn' | 'crit' | false;
}

const NO_BREACH: RunwaySummary = { months: null, alreadyBreached: false };

export function runwayToWarn(months: ForecastMonthPoint[]): RunwaySummary {
  for (let i = 0; i < months.length; i++) {
    const m = months[i]!;
    if (m.capacity <= 0) continue;
    const u = m.consumption / m.capacity;
    if (u >= WARN_THRESHOLD) {
      const breached = i === 0 ? (u >= CRIT_THRESHOLD ? 'crit' : 'warn') : false;
      return { months: i, alreadyBreached: breached };
    }
  }
  return NO_BREACH;
}

export function fleetRunwayToWarn(series: ForecastMonthPoint[][]): RunwaySummary {
  if (series.length === 0) return NO_BREACH;
  const byMonth = new Map<string, { consumption: number; capacity: number }>();
  for (const points of series) {
    for (const p of points) {
      const agg = byMonth.get(p.month) ?? { consumption: 0, capacity: 0 };
      agg.consumption += p.consumption;
      agg.capacity += p.capacity;
      byMonth.set(p.month, agg);
    }
  }
  const merged: ForecastMonthPoint[] = Array.from(byMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, agg]) => ({
      month,
      consumption: agg.consumption,
      capacity: agg.capacity,
      utilization: agg.capacity > 0 ? agg.consumption / agg.capacity : 0,
    }));
  return runwayToWarn(merged);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lcm/web test -- forecast-summary`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/forecast-summary.ts apps/web/src/__tests__/forecast-summary.test.ts
git commit -m "feat(web): forecast-summary helper for runway-to-warn"
```

---

## Task 2: `<UtilizationGauge>` primitive

**Files:**

- Create: `apps/web/src/components/ui/utilization-gauge.tsx`
- Create test: `apps/web/src/components/ui/utilization-gauge.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/ui/utilization-gauge.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UtilizationGauge } from './utilization-gauge';

describe('<UtilizationGauge>', () => {
  it('renders the percentage as text with one decimal', () => {
    render(<UtilizationGauge value={0.482} />);
    expect(screen.getByText('48.2%')).toBeInTheDocument();
  });

  it('reports an accessible name describing the status band', () => {
    render(<UtilizationGauge value={0.5} aria-labelledby="gauge-label" />);
    const gauge = screen.getByRole('img');
    expect(gauge).toHaveAccessibleName(/50\.0%, status: ok/i);
  });

  it('reports the warning band for values in [0.7, 0.9)', () => {
    render(<UtilizationGauge value={0.75} />);
    expect(screen.getByRole('img')).toHaveAccessibleName(/status: warning/i);
  });

  it('reports the critical band at or above 0.9', () => {
    render(<UtilizationGauge value={0.95} />);
    expect(screen.getByRole('img')).toHaveAccessibleName(/status: critical/i);
  });

  it('renders an em-dash and a neutral status when value is undefined', () => {
    render(<UtilizationGauge value={undefined} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(/status: empty/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/web test -- utilization-gauge`
Expected: FAIL — cannot resolve `'./utilization-gauge'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/ui/utilization-gauge.tsx`:

```tsx
import * as React from 'react';

import { cn } from '@/lib/utils';

export type GaugeSize = 'sm' | 'md' | 'lg';

interface UtilizationGaugeProps extends React.SVGAttributes<SVGSVGElement> {
  /** 0..1 ratio (consumption / capacity), or undefined when there is no data. */
  value: number | undefined;
  size?: GaugeSize;
}

const DIMENSIONS: Record<GaugeSize, { px: number; stroke: number; font: string }> = {
  sm: { px: 28, stroke: 4, font: 'text-[9px]' },
  md: { px: 56, stroke: 6, font: 'text-xs' },
  lg: { px: 96, stroke: 9, font: 'text-base' },
};

function bandOf(value: number): 'ok' | 'warning' | 'critical' {
  if (value >= 0.9) return 'critical';
  if (value >= 0.7) return 'warning';
  return 'ok';
}

function nextBandOf(band: 'ok' | 'warning' | 'critical'): 'warning' | 'critical' {
  return band === 'ok' ? 'warning' : 'critical';
}

const FILL: Record<'ok' | 'warning' | 'critical', string> = {
  ok: 'var(--utilization-ok, oklch(60% 0.18 142))',
  warning: 'var(--utilization-warn, oklch(70% 0.20 80))',
  critical: 'var(--utilization-crit, oklch(58% 0.22 25))',
};

export function UtilizationGauge({
  value,
  size = 'md',
  className,
  ...props
}: UtilizationGaugeProps): React.JSX.Element {
  const { px, stroke, font } = DIMENSIONS[size];
  const radius = (px - stroke) / 2;
  const cx = px / 2;
  const cy = px / 2;
  const circumference = 2 * Math.PI * radius;

  const hasValue = typeof value === 'number' && Number.isFinite(value);
  const clamped = hasValue ? Math.min(Math.max(value, 0), 1) : 0;
  const band = hasValue ? bandOf(clamped) : null;
  const nextBand = band ? nextBandOf(band) : null;

  const label = hasValue ? `${(clamped * 100).toFixed(1)}%, status: ${band}` : '—, status: empty';

  return (
    <div className={cn('relative inline-flex items-center justify-center', className)}>
      <svg
        role="img"
        aria-label={label}
        width={px}
        height={px}
        viewBox={`0 0 ${px} ${px}`}
        className="-rotate-90"
        {...props}
      >
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke={nextBand ? FILL[nextBand] : 'var(--border)'}
          strokeOpacity={nextBand ? 0.18 : 1}
          strokeWidth={stroke}
        />
        {hasValue && band ? (
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            stroke={FILL[band]}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circumference * clamped} ${circumference}`}
          />
        ) : null}
      </svg>
      <span aria-hidden className={cn('absolute font-mono font-semibold tabular-nums', font)}>
        {hasValue ? `${(clamped * 100).toFixed(1)}%` : '—'}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lcm/web test -- utilization-gauge`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/utilization-gauge.tsx apps/web/src/components/ui/utilization-gauge.test.tsx
git commit -m "feat(web): UtilizationGauge primitive"
```

---

## Task 3: `<RunwayPill>` primitive

**Files:**

- Create: `apps/web/src/components/ui/runway-pill.tsx`
- Create test: `apps/web/src/components/ui/runway-pill.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/ui/runway-pill.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RunwayPill } from './runway-pill';

describe('<RunwayPill>', () => {
  it('renders months until warn with a success variant when >= 12', () => {
    render(<RunwayPill summary={{ months: 18, alreadyBreached: false }} />);
    const pill = screen.getByText(/18 mo to 70%/i);
    expect(pill).toBeInTheDocument();
    expect(pill.parentElement?.className).toMatch(/success/);
  });

  it('uses the amber variant when months < 12', () => {
    render(<RunwayPill summary={{ months: 5, alreadyBreached: false }} />);
    const pill = screen.getByText(/5 mo to 70%/i);
    expect(pill.parentElement?.className).toMatch(/warning/);
  });

  it('uses the red variant when months < 3', () => {
    render(<RunwayPill summary={{ months: 2, alreadyBreached: false }} />);
    const pill = screen.getByText(/2 mo to 70%/i);
    expect(pill.parentElement?.className).toMatch(/danger/);
  });

  it('shows "Over 70%" amber when already breached at warn', () => {
    render(<RunwayPill summary={{ months: 0, alreadyBreached: 'warn' }} />);
    const pill = screen.getByText(/Over 70%/i);
    expect(pill.parentElement?.className).toMatch(/warning/);
  });

  it('shows "Over 90%" red when already breached at crit', () => {
    render(<RunwayPill summary={{ months: 0, alreadyBreached: 'crit' }} />);
    const pill = screen.getByText(/Over 90%/i);
    expect(pill.parentElement?.className).toMatch(/danger/);
  });

  it('shows the horizon hint with a "+" when there is no projected breach', () => {
    render(<RunwayPill summary={{ months: null, alreadyBreached: false }} horizonMonths={24} />);
    expect(screen.getByText(/24\+ mo/i)).toBeInTheDocument();
  });

  it('renders em-dash when the summary is undefined', () => {
    render(<RunwayPill summary={undefined} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/web test -- runway-pill`
Expected: FAIL — cannot resolve `'./runway-pill'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/ui/runway-pill.tsx`:

```tsx
import * as React from 'react';

import { Badge } from '@/components/ui/badge';

import type { RunwaySummary } from '@/lib/forecast-summary';

interface RunwayPillProps {
  summary: RunwaySummary | undefined;
  /** Forecast horizon length in months, used to display "N+ mo" when no breach. */
  horizonMonths?: number;
}

export function RunwayPill({ summary, horizonMonths }: RunwayPillProps): React.JSX.Element {
  if (!summary) {
    return <Badge variant="outline">—</Badge>;
  }
  if (summary.alreadyBreached === 'crit') {
    return <Badge variant="danger">Over 90%</Badge>;
  }
  if (summary.alreadyBreached === 'warn') {
    return <Badge variant="warning">Over 70%</Badge>;
  }
  if (summary.months === null) {
    return (
      <Badge variant="success">
        {horizonMonths ? `${horizonMonths}+ mo` : 'No breach in horizon'}
      </Badge>
    );
  }
  const variant = summary.months < 3 ? 'danger' : summary.months < 12 ? 'warning' : 'success';
  return <Badge variant={variant}>{`${summary.months} mo to 70%`}</Badge>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lcm/web test -- runway-pill`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/runway-pill.tsx apps/web/src/components/ui/runway-pill.test.tsx
git commit -m "feat(web): RunwayPill primitive"
```

---

## Task 4: Cluster card uses gauge + runway

**Files:**

- Modify: `apps/web/src/components/overview/cluster-tile.tsx`
- (No new test file — the existing cluster-table tests are unaffected; the overview KPIs are e2e-tested in Task 11.)

- [ ] **Step 1: Replace the file**

Overwrite `apps/web/src/components/overview/cluster-tile.tsx`:

```tsx
import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { Link } from '@tanstack/react-router';
import * as React from 'react';

import { RunwayPill } from '@/components/ui/runway-pill';
import { UtilizationGauge } from '@/components/ui/utilization-gauge';
import { Card } from '@/components/ui/card';
import { runwayToWarn } from '@/lib/forecast-summary';
import { cn } from '@/lib/utils';

interface ClusterTileProps extends React.HTMLAttributes<HTMLAnchorElement> {
  cluster: ClusterResponse;
  forecastMonths: ForecastMonthPoint[];
  horizonMonths: number;
}

const numberFormat = new Intl.NumberFormat('en-US');

export function ClusterTile({
  cluster,
  forecastMonths,
  horizonMonths,
  className,
  ...props
}: ClusterTileProps): React.JSX.Element {
  const metric = cluster.metrics[0];
  const summary = metric ? runwayToWarn(forecastMonths) : undefined;
  return (
    <Link
      to="/clusters/$id"
      params={{ id: cluster.id }}
      className={cn(
        'block rounded-xl transition-shadow duration-150 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className,
      )}
      {...props}
    >
      <Card className="flex h-[136px] items-center gap-4 p-4">
        <UtilizationGauge value={metric?.utilization} size="lg" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold">{cluster.name}</h3>
          {metric ? (
            <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
              {numberFormat.format(Math.round(metric.currentConsumption))} /{' '}
              {numberFormat.format(Math.round(metric.currentCapacity))} GB
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">No baseline</p>
          )}
          <div className="mt-3">
            <RunwayPill summary={summary} horizonMonths={horizonMonths} />
          </div>
        </div>
      </Card>
    </Link>
  );
}
```

- [ ] **Step 2: Update the only call site to pass new props**

Edit `apps/web/src/routes/index.tsx` lines 123-137. Replace:

```tsx
{
  summary.perClusterSeries.map((series) => {
    const cluster = clusters.find((c) => c.id === series.clusterId);
    if (!cluster) return null;
    const trend = series.months.slice(-12).map((m) => m.consumption);
    const ceiling = series.months.slice(-12).map((m) => m.capacity);
    return (
      <ClusterTile
        key={series.clusterId}
        className="col-span-12 md:col-span-6"
        cluster={cluster}
        trend={trend}
        trendCeiling={ceiling}
      />
    );
  });
}
```

With:

```tsx
{
  summary.perClusterSeries.map((series) => {
    const cluster = clusters.find((c) => c.id === series.clusterId);
    if (!cluster) return null;
    return (
      <ClusterTile
        key={series.clusterId}
        className="col-span-12 md:col-span-6"
        cluster={cluster}
        forecastMonths={series.months}
        horizonMonths={series.months.length}
      />
    );
  });
}
```

- [ ] **Step 3: Write a smoke test for `<ClusterTile>`**

Create `apps/web/src/components/overview/cluster-tile.test.tsx`:

```tsx
import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ClusterTile } from './cluster-tile';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => {
    let href = to;
    for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, v);
    return <a href={href}>{children}</a>;
  },
}));

const cluster: ClusterResponse = {
  id: 'c1',
  name: 'CL-Test',
  description: null,
  baselineDate: '2026-05-01',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  metrics: [
    {
      metricTypeKey: 'memory_gb',
      metricTypeDisplayName: 'Memory',
      unit: 'GB',
      baselineConsumption: 400,
      baselineCapacity: 1000,
      currentConsumption: 400,
      currentCapacity: 1000,
      utilization: 0.4,
    },
  ],
};

const months: ForecastMonthPoint[] = [
  { month: '2026-05-01', consumption: 400, capacity: 1000, utilization: 0.4 },
  { month: '2026-06-01', consumption: 500, capacity: 1000, utilization: 0.5 },
];

describe('<ClusterTile>', () => {
  it('renders the gauge, used/cap, runway pill, and a link to detail', () => {
    render(<ClusterTile cluster={cluster} forecastMonths={months} horizonMonths={2} />);
    expect(screen.getByRole('img', { name: /40\.0%, status: ok/i })).toBeInTheDocument();
    expect(screen.getByText(/400 \/ 1,000 GB/)).toBeInTheDocument();
    expect(screen.getByText(/2\+ mo/)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/clusters/c1');
  });
});
```

- [ ] **Step 4: Verify typecheck + tests + lint stay green**

Run: `pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web test && pnpm --filter @lcm/web lint`
Expected: all green. (Sparkline files still exist — Task 12 deletes them.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/overview/cluster-tile.tsx apps/web/src/components/overview/cluster-tile.test.tsx apps/web/src/routes/index.tsx
git commit -m "feat(web): cluster tile shows gauge + runway pill"
```

---

## Task 5: Cluster table — drop sparkline + Actions, add Runway, clickable rows

**Files:**

- Modify: `apps/web/src/components/clusters/cluster-table.tsx`
- Modify test: `apps/web/src/components/clusters/cluster-table.test.tsx`

- [ ] **Step 1: Add failing tests for the new behavior**

Append to `apps/web/src/components/clusters/cluster-table.test.tsx` after the existing `describe('ClusterTable sorting', ...)` block:

```tsx
describe('ClusterTable runway + navigation', () => {
  const clusters = [
    makeCluster({ name: 'Cluster-A', metric: { consumption: 200, capacity: 1000 } }),
  ];

  it('renders a Runway column with em-dash when no forecast prop is provided', () => {
    renderTable(clusters);
    const row = screen.getAllByRole('row')[1]!;
    expect(within(row).getByText('—')).toBeInTheDocument();
  });

  it('makes the row a link to the cluster detail page', () => {
    renderTable(clusters);
    const row = screen.getAllByRole('row')[1]!;
    const link = within(row).getByRole('link');
    expect(link).toHaveAttribute('href', '/clusters/c-Cluster-A');
  });

  it('no longer renders the Actions column', () => {
    renderTable(clusters);
    expect(screen.queryByRole('columnheader', { name: /actions/i })).toBeNull();
  });

  it('no longer renders the 12-month trend column', () => {
    renderTable(clusters);
    expect(screen.queryByRole('columnheader', { name: /12-month/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run new tests to verify they fail**

Run: `pnpm --filter @lcm/web test -- cluster-table`
Expected: FAIL — Actions column still present, link not on row, etc.

- [ ] **Step 3: Rewrite the table**

Overwrite `apps/web/src/components/clusters/cluster-table.tsx`:

```tsx
import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Card } from '@/components/ui/card';
import { RunwayPill } from '@/components/ui/runway-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { runwayToWarn } from '@/lib/forecast-summary';
import { cn } from '@/lib/utils';

import { UtilizationBadge } from './utilization-badge';

interface ClusterTableProps {
  clusters: ClusterResponse[];
  /** Per-cluster forecast months, keyed by cluster id. Optional — runway shows '—' when missing. */
  forecastsById?: Record<string, ForecastMonthPoint[]>;
  horizonMonths?: number;
}

type SortKey = 'name' | 'consumption' | 'capacity' | 'utilization' | 'runway';
type SortDir = 'asc' | 'desc';

interface SortState {
  key: SortKey;
  dir: SortDir;
}

const numberFormat = new Intl.NumberFormat('en-US');
// Used as the "no breach" sentinel for sort ordering — larger than any realistic horizon.
const RUNWAY_NONE = Number.POSITIVE_INFINITY;

export function ClusterTable({
  clusters,
  forecastsById,
  horizonMonths,
}: ClusterTableProps): React.JSX.Element {
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });

  const rows = useMemo(
    () =>
      clusters.map((cluster) => {
        const months = forecastsById?.[cluster.id];
        const summary = months ? runwayToWarn(months) : undefined;
        const sortRunway =
          summary === undefined
            ? RUNWAY_NONE
            : summary.alreadyBreached !== false
              ? 0
              : (summary.months ?? RUNWAY_NONE);
        return { cluster, summary, sortRunway };
      }),
    [clusters, forecastsById],
  );

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const aValue = extractSortValue(a, sort.key);
      const bValue = extractSortValue(b, sort.key);
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return sort.dir === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
      }
      return sort.dir === 'asc'
        ? (aValue as number) - (bValue as number)
        : (bValue as number) - (aValue as number);
    });
    return copy;
  }, [rows, sort]);

  const toggle = (key: SortKey): void => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  };

  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead label="Cluster" sortKey="name" sort={sort} onToggle={toggle} />
            <SortableHead
              label="Consumption (GB)"
              sortKey="consumption"
              sort={sort}
              onToggle={toggle}
              align="right"
            />
            <SortableHead
              label="Capacity (GB)"
              sortKey="capacity"
              sort={sort}
              onToggle={toggle}
              align="right"
            />
            <SortableHead
              label="Utilization"
              sortKey="utilization"
              sort={sort}
              onToggle={toggle}
              align="right"
            />
            <SortableHead label="Runway" sortKey="runway" sort={sort} onToggle={toggle} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map(({ cluster, summary }) => {
            const metric = cluster.metrics[0];
            return (
              <TableRow
                key={cluster.id}
                className="cursor-pointer hover:bg-muted/60 focus-within:bg-muted/60"
              >
                <TableCell className="font-medium">
                  <Link
                    to="/clusters/$id"
                    params={{ id: cluster.id }}
                    className="block w-full focus-visible:outline-none"
                  >
                    {cluster.name}
                  </Link>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {metric ? numberFormat.format(Math.round(metric.currentConsumption)) : '—'}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {metric ? numberFormat.format(Math.round(metric.currentCapacity)) : '—'}
                </TableCell>
                <TableCell className="text-right">
                  {metric ? <UtilizationBadge value={metric.utilization} /> : '—'}
                </TableCell>
                <TableCell>
                  {summary === undefined ? (
                    '—'
                  ) : (
                    <RunwayPill summary={summary} horizonMonths={horizonMonths} />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

interface Row {
  cluster: ClusterResponse;
  sortRunway: number;
}

function extractSortValue(row: Row, key: SortKey): string | number {
  const metric = row.cluster.metrics[0];
  switch (key) {
    case 'name':
      return row.cluster.name.toLowerCase();
    case 'consumption':
      return metric?.currentConsumption ?? 0;
    case 'capacity':
      return metric?.currentCapacity ?? 0;
    case 'utilization':
      return metric?.utilization ?? 0;
    case 'runway':
      return row.sortRunway;
  }
}

interface SortableHeadProps {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onToggle: (key: SortKey) => void;
  align?: 'left' | 'right';
}

function SortableHead({
  label,
  sortKey,
  sort,
  onToggle,
  align = 'left',
}: SortableHeadProps): React.JSX.Element {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 rounded hover:text-foreground',
          align === 'right' && 'ml-auto flex-row-reverse',
          active && 'text-foreground',
        )}
        aria-sort={!active ? 'none' : sort.dir === 'asc' ? 'ascending' : 'descending'}
      >
        <span>{label}</span>
        <Icon className="h-3.5 w-3.5" />
      </button>
    </TableHead>
  );
}
```

- [ ] **Step 4: Remove the sparkline-cell mock from the test file**

Edit `apps/web/src/components/clusters/cluster-table.test.tsx`. Delete lines 32-35:

```tsx
// Sparkline cell fires its own forecast query — short-circuit it for these tests.
vi.mock('./cluster-sparkline-cell', () => ({
  ClusterSparklineCell: () => null,
}));
```

And remove the now-unused `vi` import on line 5: change

```tsx
import { describe, expect, it, vi } from 'vitest';
```

to

```tsx
import { describe, expect, it } from 'vitest';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @lcm/web test -- cluster-table`
Expected: all tests in this file PASS (existing 4 + new 4 = 8).

- [ ] **Step 6: Typecheck + lint**

Run: `pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint`
Expected: both clean. (Sparkline files still exist — Task 9 deletes them.)

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/clusters/cluster-table.tsx apps/web/src/components/clusters/cluster-table.test.tsx
git commit -m "feat(web): cluster table runway column + row link"
```

---

## Task 6: Pass forecasts into the cluster table + add fleet KPI banner above

**Files:**

- Modify: `apps/web/src/routes/clusters.index.tsx`

The Clusters page currently only fetches the cluster list. This task adds the
per-cluster forecast queries (needed for the Runway column) and the fleet KPI
banner specified in the design (3-up: Used / Headroom / Runway, same numbers
as Overview).

- [ ] **Step 1: Read the route file to confirm structure**

Read `apps/web/src/routes/clusters.index.tsx`. It currently fetches `clusters` only.

- [ ] **Step 2: Imports**

At the top of the file, add (merging into the existing import statements where
possible):

```tsx
import type { ForecastMonthPoint, ForecastResponse } from '@lcm/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { resolveWindow } from '@/components/clusters/window-controls';
import { KpiTile } from '@/components/overview/kpi-tile';
import { aggregateFleet } from '@/lib/aggregate-fleet';
import { fleetRunwayToWarn } from '@/lib/forecast-summary';
```

- [ ] **Step 3: Add per-cluster forecast queries + compute KPIs**

In the route component, just after the existing `clustersQuery` block and
before `return (...)`, add:

```tsx
const forecastQueries = useQueries({
  queries: clusters.map((cluster) => {
    const metric = cluster.metrics[0];
    const range = resolveWindow('24mo', cluster.baselineDate);
    return {
      queryKey: ['forecast', cluster.id, metric?.metricTypeKey, range.from, range.to],
      queryFn: () =>
        api.clusters.forecast(cluster.id, {
          metric: metric!.metricTypeKey,
          from: range.from,
          to: range.to,
        }),
      enabled: Boolean(metric),
    };
  }),
});

const forecastEntries = clusters.map((c, i) => ({
  clusterId: c.id,
  data: forecastQueries[i]?.data as ForecastResponse | undefined,
}));
const forecastsById: Record<string, ForecastMonthPoint[]> = {};
let horizonMonths = 0;
clusters.forEach((cluster, i) => {
  const data = forecastQueries[i]?.data as ForecastResponse | undefined;
  if (data) {
    forecastsById[cluster.id] = data.months;
    horizonMonths = Math.max(horizonMonths, data.months.length);
  }
});

const fleetSummary = aggregateFleet(clusters, forecastEntries);
const fleetRunway = fleetRunwayToWarn(fleetSummary.perClusterSeries.map((s) => s.months));
const numberFormat = new Intl.NumberFormat('en-US');
const headroom = Math.max(0, fleetSummary.totalCapacity - fleetSummary.totalConsumption);
let runwayKpiValue: string;
let runwayKpiStatus: 'ok' | 'warn' | 'crit';
if (fleetRunway.alreadyBreached === 'crit') {
  runwayKpiValue = 'Over 90%';
  runwayKpiStatus = 'crit';
} else if (fleetRunway.alreadyBreached === 'warn') {
  runwayKpiValue = 'Over 70%';
  runwayKpiStatus = 'warn';
} else if (fleetRunway.months === null) {
  runwayKpiValue = horizonMonths > 0 ? `${horizonMonths}+ mo` : '—';
  runwayKpiStatus = 'ok';
} else {
  runwayKpiValue = `${fleetRunway.months} mo to 70%`;
  runwayKpiStatus = fleetRunway.months < 3 ? 'crit' : fleetRunway.months < 12 ? 'warn' : 'ok';
}
```

- [ ] **Step 4: Render the KPI banner above the table**

Inside the rendered JSX, immediately above the existing `<ClusterTable ... />`,
insert (within the existing layout — typically a `<div className="space-y-6">`
wrapper, so the banner becomes a sibling above the table):

```tsx
{
  clusters.length > 0 ? (
    <div className="grid grid-cols-12 gap-4">
      <KpiTile
        className="col-span-12 sm:col-span-4"
        label="Used"
        value={`${numberFormat.format(Math.round(fleetSummary.totalConsumption))} GB`}
        caption={`of ${numberFormat.format(Math.round(fleetSummary.totalCapacity))} GB capacity`}
        status={
          fleetSummary.utilization >= 0.9 ? 'crit' : fleetSummary.utilization >= 0.7 ? 'warn' : 'ok'
        }
      />
      <KpiTile
        className="col-span-12 sm:col-span-4"
        label="Headroom"
        value={`${numberFormat.format(Math.round(headroom))} GB`}
        caption={`${((1 - fleetSummary.utilization) * 100).toFixed(1)}% available`}
        status={
          fleetSummary.utilization >= 0.9 ? 'crit' : fleetSummary.utilization >= 0.7 ? 'warn' : 'ok'
        }
      />
      <KpiTile
        className="col-span-12 sm:col-span-4"
        label="Fleet runway"
        value={runwayKpiValue}
        caption={
          fleetSummary.worstCluster
            ? `limited by ${fleetSummary.worstCluster.name}`
            : 'fleet projection'
        }
        status={runwayKpiStatus}
      />
    </div>
  ) : null;
}
```

- [ ] **Step 5: Update the `<ClusterTable ... />` call to pass forecasts**

Change the existing `<ClusterTable clusters={clusters} />` call site to:

```tsx
<ClusterTable
  clusters={clusters}
  forecastsById={forecastsById}
  horizonMonths={horizonMonths || undefined}
/>
```

- [ ] **Step 6: Typecheck + tests + lint**

Run: `pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web test && pnpm --filter @lcm/web lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/clusters.index.tsx
git commit -m "feat(web): clusters page KPI banner + runway-aware table"
```

---

## Task 7: Cluster forecast chart — Y-domain, headroom band, labeled reference lines

**Files:**

- Modify: `apps/web/src/components/clusters/forecast-chart.tsx`
- Touch: `apps/web/src/components/clusters/forecast-chart.test.tsx` only if tests break.

- [ ] **Step 1: Read the existing test to know the contract**

Read `apps/web/src/components/clusters/forecast-chart.test.tsx`. Note what's asserted (Recharts renders into SVG — Testing Library can find `<text>` and `<path>` only loosely; existing tests likely assert tooltip content + presence of axis labels).

- [ ] **Step 2: Modify the chart**

In `apps/web/src/components/clusters/forecast-chart.tsx`:

(a) Replace the existing `data` mapping (around line 34-38) with one that also computes headroom and the max ceiling:

```tsx
const data = forecast.months.map((point) => ({
  month: point.month,
  consumption: Math.round(point.consumption),
  headroom: Math.max(0, Math.round(point.capacity - point.consumption)),
  capacity: Math.round(point.capacity),
}));
const maxCeiling = data.reduce((max, d) => Math.max(max, d.capacity), 0);
const ceilingForDomain = maxCeiling > 0 ? maxCeiling * 1.05 : undefined;
```

(b) Replace the `<YAxis ... />` block (around lines 68-78) to add the domain:

```tsx
<YAxis
  tick={{ fontSize: 11 }}
  stroke={colors.axis}
  tickFormatter={(v: number) => numberFormat.format(v)}
  domain={ceilingForDomain ? [0, ceilingForDomain] : ['auto', 'auto']}
  label={{
    value: 'GB',
    angle: -90,
    position: 'insideLeft',
    style: { fontSize: 11, fill: colors.axis },
  }}
/>
```

(c) Import `ReferenceLine` (top of file). Find the existing import:

```tsx
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
```

Add `ReferenceLine`:

```tsx
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
```

(d) Add a headroom Area stacked above consumption. After the consumption `<Area ... />` block (around lines 126-134), insert:

```tsx
{
  maxCeiling > 0 ? (
    <Area
      type="monotone"
      dataKey="headroom"
      name="Headroom"
      stackId="capacity"
      stroke={colors.capacity}
      strokeDasharray="2 3"
      strokeOpacity={0.6}
      fill={colors.capacity}
      fillOpacity={0.08}
      isAnimationActive={false}
    />
  ) : null;
}
```

To make consumption participate in the stack, change its `<Area ... />` to include `stackId="capacity"`:

```tsx
<Area
  type="monotone"
  dataKey="consumption"
  name="Consumption"
  stackId="capacity"
  stroke={colors.consumption}
  strokeWidth={2}
  fill="url(#forecast-consumption)"
  isAnimationActive={false}
/>
```

(e) Add two labeled reference lines, after the headroom Area and before the capacity Line:

```tsx
{
  maxCeiling > 0 ? (
    <>
      <ReferenceLine
        y={maxCeiling * 0.7}
        stroke={colors.utilizationWarn}
        strokeDasharray="2 2"
        label={{
          value: `Warn ${numberFormat.format(Math.round(maxCeiling * 0.7))}`,
          position: 'right',
          fontSize: 10,
          fill: colors.utilizationWarn,
        }}
      />
      <ReferenceLine
        y={maxCeiling * 0.9}
        stroke={colors.utilizationCrit}
        strokeDasharray="2 2"
        label={{
          value: `Crit ${numberFormat.format(Math.round(maxCeiling * 0.9))}`,
          position: 'right',
          fontSize: 10,
          fill: colors.utilizationCrit,
        }}
      />
    </>
  ) : null;
}
```

(f) Update the tooltip to include headroom. The tooltip currently reads `payload[0].value` as consumption and `payload[1].value` as capacity — but with the stacked-Area change, `payload` now has consumption + headroom (the two Areas). Reference values by `dataKey` instead. Replace the existing tooltip body's value extraction with:

```tsx
const consumption = (payload.find((p) => p.dataKey === 'consumption')?.value as number) ?? 0;
const headroom = (payload.find((p) => p.dataKey === 'headroom')?.value as number) ?? 0;
const capacity = consumption + headroom;
const utilization = capacity > 0 ? (consumption / capacity) * 100 : 0;
```

Then add a "Headroom" row to the `<dl>`, right under Capacity:

```tsx
<dt className="text-muted-foreground">Headroom</dt>
<dd className="text-right font-mono tabular-nums">
  {numberFormat.format(headroom)} GB
</dd>
```

(g) Add a "Headroom" legend item. In `ChartLegend`, after the "Capacity ceiling" `LegendItem`, insert:

```tsx
<LegendItem swatch={colors.capacity} label="Headroom" dashed faint />
```

Then extend `LegendItem` to accept a `faint?: boolean` prop and apply lower opacity to its swatch when set:

```tsx
function LegendItem({
  swatch,
  label,
  dot,
  dashed,
  faint,
}: {
  swatch: string;
  label: string;
  dot?: boolean;
  dashed?: boolean;
  faint?: boolean;
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className={dot ? 'h-2 w-2 rounded-full' : 'h-0 w-4 border-t-2'}
        style={
          dot
            ? { background: swatch, opacity: faint ? 0.4 : 1 }
            : {
                borderColor: swatch,
                borderStyle: dashed ? 'dashed' : 'solid',
                opacity: faint ? 0.4 : 1,
              }
        }
      />
      <span>{label}</span>
    </span>
  );
}
```

- [ ] **Step 3: Run tests + typecheck + lint**

Run: `pnpm --filter @lcm/web test -- forecast-chart && pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint`
Expected: all green. If `forecast-chart.test.tsx` asserts specific tooltip payload positions, update it to use `dataKey`-keyed lookups (this is a refactor, not a behavior change). If the test only checks rendered text, it should pass unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/clusters/forecast-chart.tsx apps/web/src/components/clusters/forecast-chart.test.tsx
git commit -m "feat(web): cluster forecast chart shows headroom + threshold lines"
```

---

## Task 8: Fleet capacity chart — same treatment for the stacked-Area variant

**Files:**

- Modify: `apps/web/src/components/overview/fleet-capacity-chart.tsx`

- [ ] **Step 1: Compute headroom + max ceiling**

In `fleet-capacity-chart.tsx`, replace the inline `fleetMonths` prop with a derived dataset that includes a `headroom` column:

Just before the `return` statement (around line 44), insert:

```tsx
const enrichedRows = fleetMonths.map((row) => {
  const consumed = clusters.reduce((sum, c) => {
    const v = row[c.clusterId];
    return sum + (typeof v === 'number' ? v : 0);
  }, 0);
  return { ...row, headroom: Math.max(0, row.capacityTotal - consumed) };
});
const maxCeiling = enrichedRows.reduce((max, r) => Math.max(max, r.capacityTotal), 0);
const ceilingForDomain = maxCeiling > 0 ? maxCeiling * 1.05 : undefined;
```

Pass `enrichedRows` to the `AreaChart` instead of `fleetMonths`:

```tsx
<AreaChart data={enrichedRows} margin={{ top: 12, right: 16, bottom: 0, left: 8 }}>
```

- [ ] **Step 2: Force Y-domain to ceiling and label thresholds**

Add `ReferenceLine` to the recharts import at the top of the file:

```tsx
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
```

Update the `<YAxis ... />` block (around lines 58-68) to set `domain`:

```tsx
<YAxis
  tick={{ fontSize: 11 }}
  stroke={colors.axis}
  tickFormatter={(v: number) => numberFormat.format(v)}
  domain={ceilingForDomain ? [0, ceilingForDomain] : ['auto', 'auto']}
  label={{
    value: 'GB',
    angle: -90,
    position: 'insideLeft',
    style: { fontSize: 11, fill: colors.axis },
  }}
/>
```

After the cluster `<Area>` map and before the `<Line>` capacity line, insert the headroom Area + threshold lines:

```tsx
{
  maxCeiling > 0 ? (
    <Area
      type="monotone"
      dataKey="headroom"
      name="Headroom"
      stackId="fleet"
      stroke={colors.capacity}
      strokeDasharray="2 3"
      strokeOpacity={0.6}
      fill={colors.capacity}
      fillOpacity={0.08}
      isAnimationActive={false}
    />
  ) : null;
}
{
  maxCeiling > 0 ? (
    <>
      <ReferenceLine
        y={maxCeiling * 0.7}
        stroke={colors.utilizationWarn}
        strokeDasharray="2 2"
        label={{
          value: `Warn ${numberFormat.format(Math.round(maxCeiling * 0.7))}`,
          position: 'right',
          fontSize: 10,
          fill: colors.utilizationWarn,
        }}
      />
      <ReferenceLine
        y={maxCeiling * 0.9}
        stroke={colors.utilizationCrit}
        strokeDasharray="2 2"
        label={{
          value: `Crit ${numberFormat.format(Math.round(maxCeiling * 0.9))}`,
          position: 'right',
          fontSize: 10,
          fill: colors.utilizationCrit,
        }}
      />
    </>
  ) : null;
}
```

- [ ] **Step 3: Add Headroom row to the tooltip and a Headroom swatch to the legend**

In the existing `Tooltip` content function, find the `<dl>` and add right above the "Fleet total" row:

```tsx
<dt className="text-muted-foreground">Headroom</dt>
<dd className="text-right font-mono tabular-nums">
  {numberFormat.format(
    (payload.find((p) => p.dataKey === 'headroom')?.value as number) ?? 0,
  )} GB
</dd>
```

In `FleetChartLegend`, add a Headroom item between the `·` separator and "Capacity ceiling":

```tsx
<span className="flex items-center gap-1.5">
  <span
    aria-hidden
    className="h-0 w-4 border-t-2 border-dashed"
    style={{ borderColor: colors.capacity, opacity: 0.5 }}
  />
  <span>Headroom</span>
</span>
```

- [ ] **Step 4: Typecheck + lint + test**

Run: `pnpm --filter @lcm/web test && pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/overview/fleet-capacity-chart.tsx
git commit -m "feat(web): fleet chart Y-axis ceiling + headroom band + threshold lines"
```

---

## Task 9: Monthly utilization panel — label the reference lines

**Files:**

- Modify: `apps/web/src/components/clusters/utilization-panel.tsx`

- [ ] **Step 1: Add labels to the existing reference lines**

In `apps/web/src/components/clusters/utilization-panel.tsx`, replace lines 67-68:

```tsx
<ReferenceLine y={70} stroke={colors.utilizationWarn} strokeDasharray="2 2" />
<ReferenceLine y={90} stroke={colors.utilizationCrit} strokeDasharray="2 2" />
```

With:

```tsx
<ReferenceLine
  y={70}
  stroke={colors.utilizationWarn}
  strokeDasharray="2 2"
  label={{
    value: 'Warn 70%',
    position: 'right',
    fontSize: 10,
    fill: colors.utilizationWarn,
  }}
/>
<ReferenceLine
  y={90}
  stroke={colors.utilizationCrit}
  strokeDasharray="2 2"
  label={{
    value: 'Crit 90%',
    position: 'right',
    fontSize: 10,
    fill: colors.utilizationCrit,
  }}
/>
```

- [ ] **Step 2: Make room on the right for the labels**

In the same file, line 51, change the chart margin to give the labels room:

```tsx
<BarChart data={data} margin={{ top: 4, right: 56, bottom: 0, left: 8 }}>
```

- [ ] **Step 3: Typecheck + lint + test**

Run: `pnpm --filter @lcm/web test && pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/clusters/utilization-panel.tsx
git commit -m "feat(web): label 70/90 reference lines on monthly utilization"
```

---

## Task 10: Overview KPI strip — swap Worst-cluster for Runway

**Files:**

- Modify: `apps/web/src/routes/index.tsx`

- [ ] **Step 1: Import the helper**

At the top of `apps/web/src/routes/index.tsx`, add to the existing imports:

```tsx
import { fleetRunwayToWarn } from '@/lib/forecast-summary';
```

- [ ] **Step 2: Compute fleet runway + display tile**

Find the existing third KPI tile (Worst cluster) around lines 95-111. Replace it entirely with the Runway tile.

Before the `return`, after the `summary = aggregateFleet(...)` line, add:

```tsx
const fleetRunway = fleetRunwayToWarn(summary.perClusterSeries.map((s) => s.months));
const horizonMonths = Math.max(0, ...summary.perClusterSeries.map((s) => s.months.length));

let runwayValue: string;
let runwayCaption: string;
let runwayStatus: 'ok' | 'warn' | 'crit';
if (fleetRunway.alreadyBreached === 'crit') {
  runwayValue = 'Over 90%';
  runwayCaption = 'fleet has breached crit';
  runwayStatus = 'crit';
} else if (fleetRunway.alreadyBreached === 'warn') {
  runwayValue = 'Over 70%';
  runwayCaption = 'fleet has breached warn';
  runwayStatus = 'warn';
} else if (fleetRunway.months === null) {
  runwayValue = horizonMonths > 0 ? `${horizonMonths}+ mo` : '—';
  runwayCaption = 'no projected breach';
  runwayStatus = 'ok';
} else {
  runwayValue = `${fleetRunway.months} mo to 70%`;
  runwayCaption = summary.worstCluster
    ? `limited by ${summary.worstCluster.name}`
    : 'fleet projection';
  runwayStatus = fleetRunway.months < 3 ? 'crit' : fleetRunway.months < 12 ? 'warn' : 'ok';
}
```

Then replace the third KpiTile (Worst cluster) with:

```tsx
<KpiTile
  className="col-span-12 sm:col-span-4"
  label="Fleet runway"
  value={runwayValue}
  caption={runwayCaption}
  status={runwayStatus}
/>
```

- [ ] **Step 3: Typecheck + lint + test**

Run: `pnpm --filter @lcm/web test && pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/index.tsx
git commit -m "feat(web): overview KPI strip swaps worst-cluster for runway"
```

---

## Task 11: Cluster detail KPI strip + remove standalone pill

**Files:**

- Modify: `apps/web/src/routes/clusters.$id.tsx`

- [ ] **Step 1: Imports**

Add to the imports at the top of the file:

```tsx
import type { ClusterResponse, ForecastResponse } from '@lcm/shared';
import { KpiTile } from '@/components/overview/kpi-tile';
import { RunwayPill } from '@/components/ui/runway-pill';
import { UtilizationGauge } from '@/components/ui/utilization-gauge';
import { runwayToWarn } from '@/lib/forecast-summary';
```

Remove the now-unused import:

```tsx
import { UtilizationBadge } from '@/components/clusters/utilization-badge';
```

- [ ] **Step 2: Remove the standalone "Current utilization" pill**

Find the header block (lines 57-73). Replace:

```tsx
<div className="flex flex-wrap items-end justify-between gap-4">
  <div>
    <h1 className="text-[1.625rem] font-semibold tracking-tight">{clusterQuery.data.name}</h1>
    <p className="text-sm text-muted-foreground">
      Baseline {clusterQuery.data.baselineDate}
      {clusterQuery.data.description ? ` · ${clusterQuery.data.description}` : null}
    </p>
  </div>
  {metric ? (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Current utilization</span>
      <UtilizationBadge value={metric.utilization} />
    </div>
  ) : null}
</div>
```

With:

```tsx
<div>
  <h1 className="text-[1.625rem] font-semibold tracking-tight">{clusterQuery.data.name}</h1>
  <p className="text-sm text-muted-foreground">
    Baseline {clusterQuery.data.baselineDate}
    {clusterQuery.data.description ? ` · ${clusterQuery.data.description}` : null}
  </p>
</div>
```

- [ ] **Step 3: Add the KPI strip below the title**

Inside the `{clusterQuery.data && metric ? (...)` block, immediately before the existing `<div className="flex items-center justify-between">` (line 79), insert:

```tsx
{
  forecastQuery.data ? (
    <ClusterDetailKpiStrip forecast={forecastQuery.data} metric={metric} />
  ) : null;
}
```

Add a module-level number formatter near the top of the file (just below the imports, alongside the existing helpers):

```tsx
const numberFormat = new Intl.NumberFormat('en-US');
```

Then add a new helper component at the bottom of the file (before the `HeaderSkeleton` function):

```tsx
function ClusterDetailKpiStrip({
  forecast,
  metric,
}: {
  forecast: ForecastResponse;
  metric: NonNullable<ClusterResponse['metrics'][number]>;
}): React.JSX.Element {
  const headroom = Math.max(0, metric.currentCapacity - metric.currentConsumption);
  const summary = runwayToWarn(forecast.months);
  return (
    <div className="grid grid-cols-12 gap-4">
      <Card className="col-span-12 flex items-center gap-4 p-5 sm:col-span-4">
        <UtilizationGauge value={metric.utilization} size="md" />
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Current utilization
          </p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">
            {(metric.utilization * 100).toFixed(1)}%
          </p>
        </div>
      </Card>
      <KpiTile
        className="col-span-12 sm:col-span-4"
        label="Headroom"
        value={`${numberFormat.format(Math.round(headroom))} GB`}
        caption={`of ${numberFormat.format(Math.round(metric.currentCapacity))} GB capacity`}
        status={metric.utilization >= 0.9 ? 'crit' : metric.utilization >= 0.7 ? 'warn' : 'ok'}
      />
      <Card className="col-span-12 flex flex-col justify-between p-5 sm:col-span-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Runway
        </p>
        <div className="mt-1">
          <RunwayPill summary={summary} horizonMonths={forecast.months.length} />
        </div>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + lint + test**

Run: `pnpm --filter @lcm/web test && pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/clusters.\$id.tsx
git commit -m "feat(web): cluster detail KPI strip — gauge, headroom, runway"
```

---

## Task 12: Delete dead sparkline files

**Files:**

- Delete: `apps/web/src/components/sparkline.tsx`
- Delete: `apps/web/src/components/clusters/cluster-sparkline-cell.tsx`

- [ ] **Step 1: Confirm no remaining imports**

Run: `grep -rn "from.*sparkline\|@/components/sparkline\|cluster-sparkline-cell" apps/web/src`
Expected: no matches.

- [ ] **Step 2: Delete the files**

```bash
rm apps/web/src/components/sparkline.tsx
rm apps/web/src/components/clusters/cluster-sparkline-cell.tsx
```

- [ ] **Step 3: Typecheck + lint + test**

Run: `pnpm --filter @lcm/web test && pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add -A apps/web/src/components/sparkline.tsx apps/web/src/components/clusters/cluster-sparkline-cell.tsx
git commit -m "chore(web): remove unused sparkline + cell"
```

---

## Task 13: E2E coverage in the golden-path Playwright spec

**Files:**

- Modify: `apps/web/tests/e2e/golden.spec.ts` (or the equivalent — adjust if the project uses a different name).

- [ ] **Step 1: Locate the golden-path spec**

Run: `find apps/web -name "*.spec.ts" -path "*e2e*"` to confirm path.

- [ ] **Step 2: Add new assertions**

Inside the existing golden-path test, after navigating to `/`, add:

```ts
// Overview: every cluster card shows a utilization gauge and a runway pill.
const cards = page.getByRole('link', { name: /^CL-/ });
const cardCount = await cards.count();
expect(cardCount).toBeGreaterThan(0);
for (let i = 0; i < cardCount; i++) {
  const card = cards.nth(i);
  await expect(
    card.getByRole('img', { name: /status: (ok|warning|critical|empty)/i }),
  ).toBeVisible();
  await expect(card.getByText(/mo to 70%|Over 70%|Over 90%|mo$/)).toBeVisible();
}
```

After navigating to `/clusters/<some-cluster-id>`, add:

```ts
// KPI strip is a 3-up.
await expect(page.getByText('Current utilization')).toBeVisible();
await expect(page.getByText('Headroom', { exact: true })).toBeVisible();
await expect(page.getByText('Runway', { exact: true })).toBeVisible();
```

After navigating to `/clusters`, add:

```ts
// KPI banner: Used / Headroom / Fleet runway.
await expect(page.getByText(/^Used$/)).toBeVisible();
await expect(page.getByText(/^Headroom$/)).toBeVisible();
await expect(page.getByText(/^Fleet runway$/)).toBeVisible();

// Runway column is present; row click navigates to detail.
await expect(page.getByRole('columnheader', { name: /runway/i })).toBeVisible();
await expect(page.getByRole('columnheader', { name: /actions/i })).toHaveCount(0);
const firstRow = page.getByRole('row').nth(1);
await firstRow.getByRole('link').first().click();
await expect(page).toHaveURL(/\/clusters\/[a-z0-9]+/);
```

- [ ] **Step 3: Run the e2e**

Run: `pnpm --filter @lcm/web test:e2e`
Expected: PASS. (Requires `pnpm dev` to be running or use whatever setup the existing test uses.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/e2e/
git commit -m "test(web): e2e covers gauge + runway pill + detail KPI strip"
```

---

## Task 14: Manual verification in Playwright (light + dark)

This task is not committed; it produces evidence and a final sanity check.

- [ ] **Step 1: Make sure the dev stack is up**

```bash
docker ps --filter "name=lcm" --format "{{.Names}} {{.Status}}"
```

Or `pnpm dev` + `docker compose -f docker-compose.dev.yml up -d db`.

- [ ] **Step 2: Inspect each route at 1440×900 light + dark**

Using Playwright MCP (or screen capture), navigate to:

- `/` light
- `/` dark
- `/clusters` light
- `/clusters/:id` light
- `/clusters/:id` dark

For each, confirm:

- The capacity ceiling line is **inside** the chart, not at the top edge.
- A faint, dashed headroom band is visible between consumption and ceiling.
- Reference lines at 70 % / 90 % carry visible labels at the right edge.
- Cluster cards on `/` show a gauge + runway pill, **no sparkline**.
- Cluster detail page has a 3-up KPI strip (gauge / headroom / runway).
- Clusters table shows a Runway column and rows are clickable.

- [ ] **Step 3: Resolve any visual regressions before declaring done**

If any of the above are wrong, file a follow-up task in the same plan rather than amending earlier commits.

---

## Definition of done

- All unit tests in `apps/web/src/**/__tests__` and `apps/web/src/**/*.test.tsx` pass.
- `pnpm --filter @lcm/web test:e2e` passes.
- `pnpm lint` and `pnpm typecheck` are clean at the repo root.
- Manual checks from Task 14 are satisfied.
- Spec items not implemented by any task (per the Self-review pass below) are explicitly listed as follow-ups.
