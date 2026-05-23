# Bento Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/` a bento Overview (KPI tiles + fleet chart + per-cluster tiles); move the existing cluster table to `/clusters`; update sidebar/breadcrumbs/palette/shortcuts; client-side aggregation only.

**Architecture:** A pure `aggregateFleet()` helper sums per-cluster forecast data into shapes ready for the chart and KPI tiles. Three new components (`KpiTile`, `ClusterTile`, `FleetCapacityChart`) render the layout. Existing `useChartColors` gains a `clusterPalette` field so the stacked-area chart picks stable per-cluster colors.

**Tech Stack:** React 19, TanStack Router (file-based), TanStack Query (`useQueries`), Recharts 2, Tailwind v4, existing shadcn-style primitives.

**Spec:** [`docs/superpowers/specs/2026-05-23-bento-overview-design.md`](../specs/2026-05-23-bento-overview-design.md)

**Branch:** `bento-overview` (already checked out; spec committed as `a90d993`).

**Project conventions:**

- Husky pre-commit runs Prettier + `pnpm -r typecheck`. Don't bypass.
- Single quotes; named exports; React 19 `React.JSX.Element` return types.
- Path alias `@/` → `apps/web/src/`.
- ESLint enforces `react-hooks/rules-of-hooks` (added in the UI-refresh branch).

---

## File Structure

**New (6 files):**

```
apps/web/src/
├─ lib/
│  └─ aggregate-fleet.ts           Pure helper + tests
├─ components/overview/
│  ├─ kpi-tile.tsx                 Single-stat Card
│  ├─ cluster-tile.tsx             Clickable cluster Card
│  └─ fleet-capacity-chart.tsx     Stacked-area Recharts
├─ routes/
│  └─ clusters.index.tsx           Existing dashboard table content (moved)
└─ __tests__/
   └─ aggregate-fleet.test.ts      5 tests
```

**Modified (7 files):**

```
apps/web/src/
├─ lib/use-chart-colors.ts                          + clusterPalette: string[]
├─ routes/index.tsx                                 Full rewrite: bento Overview
├─ components/layout/sidebar.tsx                    Nav items (Overview/Clusters/Settings)
├─ components/layout/breadcrumbs.tsx                Path patterns updated
├─ components/command/command-palette.tsx           Navigation items renamed
├─ components/command/keyboard-shortcuts.tsx        g o / g c / g s
├─ components/command/shortcuts-dialog.tsx          ROWS updated
└─ __tests__/keyboard-shortcuts.test.tsx            g c → /clusters
playwright/golden-path.spec.ts                      page.goto('/clusters')
```

**Untouched:** API, schema, `packages/shared`, ThemeProvider, useTheme, Card, Badge, Button, Kbd, Tooltip, Toaster, Sparkline, ForecastChart, UtilizationPanel, UtilizationBadge, cluster-table.tsx, the existing `routes/clusters.$id.tsx` + `routes/clusters.new.tsx` route files themselves, all CI/Docker config.

---

## Task 1 — Chart palette + fleet-aggregation helper (with TDD)

**Files:**

- Modify: `apps/web/src/lib/use-chart-colors.ts`
- Create: `apps/web/src/lib/aggregate-fleet.ts`
- Create: `apps/web/src/__tests__/aggregate-fleet.test.ts`

**Goal:** A `clusterPalette` field on `ChartColors` and a pure `aggregateFleet()` function with 5 passing tests covering empty/single/multi/missing-forecast/worst-cluster paths.

- [ ] **Step 1: Add `clusterPalette` to `apps/web/src/lib/use-chart-colors.ts`.**

Add a new field on the `ChartColors` interface and populate both `LIGHT` and `DARK`.

In the `ChartColors` interface (currently ends with `event: Record<EventCategory, string>;`), add immediately before the closing brace:

```ts
  clusterPalette: string[];
```

In the `LIGHT` constant (currently ends with the `event` object), insert before the closing brace:

```ts
  clusterPalette: [
    'oklch(55% 0.18 262)', // indigo
    'oklch(58% 0.18 195)', // teal
    'oklch(60% 0.17 145)', // green
    'oklch(62% 0.19 60)',  // amber
    'oklch(60% 0.22 25)',  // red
    'oklch(58% 0.20 305)', // violet
  ],
```

In the `DARK` constant, insert before the closing brace:

```ts
  clusterPalette: [
    'oklch(72% 0.16 262)',
    'oklch(74% 0.14 195)',
    'oklch(75% 0.13 145)',
    'oklch(78% 0.16 60)',
    'oklch(75% 0.18 25)',
    'oklch(74% 0.16 305)',
  ],
```

- [ ] **Step 2: Write the failing test for `aggregateFleet`.**

Create `apps/web/src/__tests__/aggregate-fleet.test.ts`:

```ts
import type { ClusterResponse, ForecastResponse } from '@lcm/shared';
import { describe, expect, test } from 'vitest';

import { aggregateFleet } from '@/lib/aggregate-fleet';

function makeCluster(id: string, name: string): ClusterResponse {
  return {
    id,
    name,
    description: null,
    baselineDate: '2026-01-01',
    tenantId: 'default',
    metrics: [],
  } as unknown as ClusterResponse;
}

function makeForecast(rows: Array<[string, number, number]>): ForecastResponse {
  return {
    fromMonth: rows[0]?.[0] ?? '2026-01-01',
    toMonth: rows[rows.length - 1]?.[0] ?? '2026-01-01',
    events: [],
    hosts: [],
    applications: [],
    months: rows.map(([month, consumption, capacity]) => ({
      month,
      consumption,
      capacity,
      utilization: capacity > 0 ? consumption / capacity : 0,
    })),
  };
}

describe('aggregateFleet', () => {
  test('empty cluster list yields zeroes', () => {
    const r = aggregateFleet([], []);
    expect(r.totalConsumption).toBe(0);
    expect(r.totalCapacity).toBe(0);
    expect(r.utilization).toBe(0);
    expect(r.clusterCount).toBe(0);
    expect(r.worstCluster).toBeNull();
    expect(r.perClusterSeries).toEqual([]);
    expect(r.fleetMonths).toEqual([]);
  });

  test('single cluster sums to its own forecast', () => {
    const c = makeCluster('a', 'A');
    const f = makeForecast([
      ['2026-01-01', 100, 500],
      ['2026-02-01', 120, 500],
    ]);
    const r = aggregateFleet([c], [{ clusterId: 'a', data: f }]);
    expect(r.totalConsumption).toBe(120);
    expect(r.totalCapacity).toBe(500);
    expect(r.utilization).toBeCloseTo(0.24, 5);
    expect(r.clusterCount).toBe(1);
    expect(r.worstCluster?.id).toBe('a');
    expect(r.fleetMonths).toHaveLength(2);
    expect(r.fleetMonths[1]).toMatchObject({
      month: '2026-02-01',
      capacityTotal: 500,
      a: 120,
    });
  });

  test('multi-cluster sums per month and picks worst', () => {
    const a = makeCluster('a', 'A');
    const b = makeCluster('b', 'B');
    const fa = makeForecast([
      ['2026-01-01', 100, 1000],
      ['2026-02-01', 200, 1000],
    ]);
    const fb = makeForecast([
      ['2026-01-01', 400, 500],
      ['2026-02-01', 450, 500],
    ]);
    const r = aggregateFleet(
      [a, b],
      [
        { clusterId: 'a', data: fa },
        { clusterId: 'b', data: fb },
      ],
    );
    expect(r.totalConsumption).toBe(650);
    expect(r.totalCapacity).toBe(1500);
    expect(r.utilization).toBeCloseTo(650 / 1500, 5);
    expect(r.worstCluster?.id).toBe('b');
    expect(r.worstCluster?.utilization).toBeCloseTo(0.9, 5);
    expect(r.fleetMonths[1]).toMatchObject({
      month: '2026-02-01',
      capacityTotal: 1500,
      a: 200,
      b: 450,
    });
  });

  test('missing forecast for a cluster — cluster present but contributes nothing', () => {
    const a = makeCluster('a', 'A');
    const b = makeCluster('b', 'B');
    const fa = makeForecast([['2026-01-01', 100, 500]]);
    const r = aggregateFleet(
      [a, b],
      [
        { clusterId: 'a', data: fa },
        { clusterId: 'b', data: undefined },
      ],
    );
    expect(r.totalConsumption).toBe(100);
    expect(r.totalCapacity).toBe(500);
    expect(r.clusterCount).toBe(2);
    expect(r.worstCluster?.id).toBe('a');
    expect(r.perClusterSeries).toHaveLength(2); // both clusters present in series list
    expect(r.perClusterSeries[1]?.months).toEqual([]); // B has no months
  });

  test('zero-capacity cluster does not divide by zero', () => {
    const a = makeCluster('a', 'A');
    const fa = makeForecast([['2026-01-01', 0, 0]]);
    const r = aggregateFleet([a], [{ clusterId: 'a', data: fa }]);
    expect(r.utilization).toBe(0);
    expect(r.worstCluster?.utilization).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails.**

```bash
pnpm --filter @lcm/web test -- aggregate-fleet
```

Expected: FAIL with "Failed to resolve import '@/lib/aggregate-fleet'".

- [ ] **Step 4: Implement `aggregateFleet()`.**

Create `apps/web/src/lib/aggregate-fleet.ts`:

```ts
import type { ClusterResponse, ForecastMonthPoint, ForecastResponse } from '@lcm/shared';

export interface FleetSummary {
  totalConsumption: number;
  totalCapacity: number;
  utilization: number;
  clusterCount: number;
  worstCluster: { id: string; name: string; utilization: number } | null;
  perClusterSeries: Array<{
    clusterId: string;
    clusterName: string;
    months: ForecastMonthPoint[];
  }>;
  fleetMonths: Array<{
    month: string;
    capacityTotal: number;
    [clusterId: string]: number | string;
  }>;
}

interface ForecastEntry {
  clusterId: string;
  data: ForecastResponse | undefined;
}

export function aggregateFleet(
  clusters: ClusterResponse[],
  forecasts: ForecastEntry[],
): FleetSummary {
  if (clusters.length === 0) {
    return {
      totalConsumption: 0,
      totalCapacity: 0,
      utilization: 0,
      clusterCount: 0,
      worstCluster: null,
      perClusterSeries: [],
      fleetMonths: [],
    };
  }

  const forecastMap = new Map(forecasts.map((f) => [f.clusterId, f.data]));

  // perClusterSeries — sorted by cluster ID for stable color mapping.
  const sortedClusters = [...clusters].sort((a, b) => a.id.localeCompare(b.id));
  const perClusterSeries = sortedClusters.map((c) => ({
    clusterId: c.id,
    clusterName: c.name,
    months: forecastMap.get(c.id)?.months ?? [],
  }));

  // Collect every unique month across all clusters, sorted.
  const monthSet = new Set<string>();
  for (const series of perClusterSeries) {
    for (const point of series.months) {
      monthSet.add(point.month);
    }
  }
  const months = Array.from(monthSet).sort();

  // Build per-month rows: { month, capacityTotal, [clusterId]: consumption }.
  const fleetMonths = months.map((month) => {
    const row: { month: string; capacityTotal: number; [clusterId: string]: number | string } = {
      month,
      capacityTotal: 0,
    };
    for (const series of perClusterSeries) {
      const point = series.months.find((p) => p.month === month);
      row[series.clusterId] = point?.consumption ?? 0;
      row.capacityTotal += point?.capacity ?? 0;
    }
    return row;
  });

  // Most-recent month totals (last entry of fleetMonths).
  const latest = fleetMonths[fleetMonths.length - 1];
  let totalConsumption = 0;
  let totalCapacity = 0;
  if (latest) {
    for (const series of perClusterSeries) {
      const v = latest[series.clusterId];
      if (typeof v === 'number') totalConsumption += v;
    }
    totalCapacity = latest.capacityTotal;
  }
  const utilization = totalCapacity > 0 ? totalConsumption / totalCapacity : 0;

  // Worst cluster: highest most-recent utilization.
  let worstCluster: FleetSummary['worstCluster'] = null;
  for (const series of perClusterSeries) {
    const last = series.months[series.months.length - 1];
    if (!last) continue;
    const u = last.capacity > 0 ? last.consumption / last.capacity : 0;
    if (!worstCluster || u > worstCluster.utilization) {
      worstCluster = { id: series.clusterId, name: series.clusterName, utilization: u };
    }
  }

  return {
    totalConsumption,
    totalCapacity,
    utilization,
    clusterCount: clusters.length,
    worstCluster,
    perClusterSeries,
    fleetMonths,
  };
}
```

- [ ] **Step 5: Run tests — verify all 5 pass.**

```bash
pnpm --filter @lcm/web test -- aggregate-fleet
```

Expected: PASS, 5/5.

- [ ] **Step 6: Run full test suite + typecheck.**

```bash
pnpm --filter @lcm/web test
pnpm --filter @lcm/web typecheck
```

Expected: pass (existing 18 + 5 new = 23 tests; typecheck clean).

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/lib/use-chart-colors.ts apps/web/src/lib/aggregate-fleet.ts apps/web/src/__tests__/aggregate-fleet.test.ts
git commit -m "feat(web): clusterPalette + aggregateFleet helper

ChartColors gains a 6-color clusterPalette (indigo/teal/green/amber/red/violet)
in both light and dark, used by the upcoming fleet capacity chart. Pure
aggregateFleet() sums per-cluster forecast data into shapes ready for the
KPI tiles and stacked-area chart: totals, per-month rows keyed by cluster
id, and the worst-utilization cluster. 5 unit tests covering empty,
single, multi-cluster, missing-forecast, and zero-capacity paths."
```

---

## Task 2 — Tile components + chart

**Files:**

- Create: `apps/web/src/components/overview/kpi-tile.tsx`
- Create: `apps/web/src/components/overview/cluster-tile.tsx`
- Create: `apps/web/src/components/overview/fleet-capacity-chart.tsx`

**Goal:** Three new presentational components. No tests; they're exercised by the route page in the next task.

- [ ] **Step 1: Create `kpi-tile.tsx`.**

Path: `apps/web/src/components/overview/kpi-tile.tsx`

```tsx
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const dotVariants = cva('h-1.5 w-1.5 rounded-full', {
  variants: {
    status: {
      ok: 'bg-success',
      warn: 'bg-warning',
      crit: 'bg-destructive',
    },
  },
});

export interface KpiTileProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof dotVariants> {
  label: string;
  value: string;
  caption?: string;
}

export function KpiTile({
  label,
  value,
  caption,
  status,
  className,
  ...props
}: KpiTileProps): React.JSX.Element {
  return (
    <Card className={cn('p-5', className)} {...props}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1.5 text-3xl font-semibold tracking-tight">{value}</p>
      {caption || status ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          {status ? <span aria-hidden className={dotVariants({ status })} /> : null}
          {caption}
        </p>
      ) : null}
    </Card>
  );
}
```

- [ ] **Step 2: Create `cluster-tile.tsx`.**

Path: `apps/web/src/components/overview/cluster-tile.tsx`

```tsx
import type { ClusterResponse } from '@lcm/shared';
import { Link } from '@tanstack/react-router';
import * as React from 'react';

import { Sparkline } from '@/components/sparkline';
import { UtilizationBadge } from '@/components/clusters/utilization-badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface ClusterTileProps extends React.HTMLAttributes<HTMLAnchorElement> {
  cluster: ClusterResponse;
  /** 12-month consumption series, oldest to newest. Empty array hides the sparkline. */
  trend: number[];
  /** 12-month capacity ceiling series, matching trend length. Optional. */
  trendCeiling?: number[];
}

const numberFormat = new Intl.NumberFormat('en-US');

export function ClusterTile({
  cluster,
  trend,
  trendCeiling,
  className,
  ...props
}: ClusterTileProps): React.JSX.Element {
  const metric = cluster.metrics[0];
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
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="truncate text-base font-semibold">{cluster.name}</h3>
          {metric ? <UtilizationBadge value={metric.utilization} /> : null}
        </div>
        {metric ? (
          <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
            {numberFormat.format(Math.round(metric.currentConsumption))} /{' '}
            {numberFormat.format(Math.round(metric.currentCapacity))} GB
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No baseline</p>
        )}
        {trend.length >= 2 ? (
          <div className="mt-3">
            <Sparkline values={trend} ceiling={trendCeiling} width={240} height={36} />
          </div>
        ) : null}
      </Card>
    </Link>
  );
}
```

- [ ] **Step 3: Create `fleet-capacity-chart.tsx`.**

Path: `apps/web/src/components/overview/fleet-capacity-chart.tsx`

```tsx
import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { useChartColors } from '@/lib/use-chart-colors';

interface FleetMonthRow {
  month: string;
  capacityTotal: number;
  [clusterId: string]: number | string;
}

interface ClusterMeta {
  clusterId: string;
  clusterName: string;
}

interface FleetCapacityChartProps {
  fleetMonths: FleetMonthRow[];
  clusters: ClusterMeta[];
}

const numberFormat = new Intl.NumberFormat('en-US');

function formatMonth(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

export function FleetCapacityChart({
  fleetMonths,
  clusters,
}: FleetCapacityChartProps): React.JSX.Element {
  const colors = useChartColors();

  return (
    <div className="h-[320px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={fleetMonths} margin={{ top: 12, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
          <XAxis
            dataKey="month"
            tickFormatter={formatMonth}
            tick={{ fontSize: 11 }}
            stroke={colors.axis}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            tick={{ fontSize: 11 }}
            stroke={colors.axis}
            tickFormatter={(v: number) => numberFormat.format(v)}
            label={{
              value: 'GB',
              angle: -90,
              position: 'insideLeft',
              style: { fontSize: 11, fill: colors.axis },
            }}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0 || typeof label !== 'string') {
                return null;
              }
              const capacity =
                (payload.find((p) => p.dataKey === 'capacityTotal')?.value as number) ?? 0;
              const clusterRows = clusters.map((c) => {
                const value =
                  (payload.find((p) => p.dataKey === c.clusterId)?.value as number) ?? 0;
                return { ...c, value };
              });
              const total = clusterRows.reduce((sum, r) => sum + r.value, 0);
              return (
                <div className="rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md">
                  <div className="font-medium">{formatMonth(label)}</div>
                  <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                    {clusterRows.map((r, idx) => (
                      <React.Fragment key={r.clusterId}>
                        <dt className="flex items-center gap-1.5 text-muted-foreground">
                          <span
                            aria-hidden
                            className="h-2 w-2 rounded-full"
                            style={{
                              background: colors.clusterPalette[idx % colors.clusterPalette.length],
                            }}
                          />
                          {r.clusterName}
                        </dt>
                        <dd className="text-right font-mono tabular-nums">
                          {numberFormat.format(r.value)}
                        </dd>
                      </React.Fragment>
                    ))}
                    <dt className="mt-1 border-t border-border pt-1 text-muted-foreground">
                      Fleet total
                    </dt>
                    <dd className="mt-1 border-t border-border pt-1 text-right font-mono tabular-nums">
                      {numberFormat.format(total)} GB
                    </dd>
                    <dt className="text-muted-foreground">Capacity ceiling</dt>
                    <dd className="text-right font-mono tabular-nums">
                      {numberFormat.format(capacity)} GB
                    </dd>
                  </dl>
                </div>
              );
            }}
          />
          {clusters.map((c, idx) => (
            <Area
              key={c.clusterId}
              type="monotone"
              stackId="fleet"
              dataKey={c.clusterId}
              name={c.clusterName}
              stroke={colors.clusterPalette[idx % colors.clusterPalette.length]}
              fill={colors.clusterPalette[idx % colors.clusterPalette.length]}
              fillOpacity={0.6}
              isAnimationActive={false}
            />
          ))}
          <Line
            type="stepAfter"
            dataKey="capacityTotal"
            name="Capacity ceiling"
            stroke={colors.capacity}
            strokeWidth={1.75}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
      <FleetChartLegend clusters={clusters} />
    </div>
  );
}

function FleetChartLegend({ clusters }: { clusters: ClusterMeta[] }): React.JSX.Element {
  const colors = useChartColors();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      {clusters.map((c, idx) => (
        <span key={c.clusterId} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{ background: colors.clusterPalette[idx % colors.clusterPalette.length] }}
          />
          <span>{c.clusterName}</span>
        </span>
      ))}
      <span aria-hidden className="mx-1">
        ·
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="h-0 w-4 border-t-2 border-dashed"
          style={{ borderColor: colors.capacity }}
        />
        <span>Capacity ceiling</span>
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Verify build + typecheck + lint.**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web build
```

Expected: all pass cleanly. (No tests added for these presentational components — they're exercised in the next task.)

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/overview/
git commit -m "feat(web): KpiTile, ClusterTile, FleetCapacityChart components

KpiTile renders single-stat Card with eyebrow, big number, optional
status dot. ClusterTile wraps a Card in a TanStack Link to the cluster
detail page with name, utilization badge, mono consumption/capacity
line, and a sparkline. FleetCapacityChart is a Recharts stacked
AreaChart with one band per cluster (clusterPalette colors), a stepped
capacity-ceiling line, and a per-cluster tooltip + legend."
```

---

## Task 3 — Routing restructure + bento page + nav/breadcrumb/palette updates

**Files:**

- Create: `apps/web/src/routes/clusters.index.tsx` (the table content moves here verbatim)
- Modify: `apps/web/src/routes/index.tsx` (full rewrite — becomes the bento)
- Modify: `apps/web/src/components/layout/sidebar.tsx`
- Modify: `apps/web/src/components/layout/breadcrumbs.tsx`
- Modify: `apps/web/src/components/command/command-palette.tsx`
- Modify: `apps/web/src/components/command/keyboard-shortcuts.tsx`
- Modify: `apps/web/src/components/command/shortcuts-dialog.tsx`

**Goal:** Routes split correctly, sidebar/breadcrumbs/palette/shortcuts all reference the new structure.

- [ ] **Step 1: Move the existing table content from `routes/index.tsx` to `routes/clusters.index.tsx`.**

First, open `apps/web/src/routes/index.tsx` and copy its entire contents. Create `apps/web/src/routes/clusters.index.tsx` with that content, then change the route declaration line. The first line currently is:

```tsx
export const Route = createFileRoute('/')({
```

In `clusters.index.tsx`, this becomes:

```tsx
export const Route = createFileRoute('/clusters/')({
```

(TanStack file-routing convention: `clusters.index.tsx` maps to `/clusters/` — the trailing slash is fine; the matcher normalizes.)

The page heading also makes sense to rename. Find:

```tsx
          <h1 className="text-[1.625rem] font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {clustersQuery.data?.length
              ? `${clustersQuery.data.length} clusters tracked`
              : 'Capacity forecasts across all tracked clusters.'}
          </p>
```

Change "Dashboard" → "Clusters":

```tsx
          <h1 className="text-[1.625rem] font-semibold tracking-tight">Clusters</h1>
          <p className="text-sm text-muted-foreground">
            {clustersQuery.data?.length
              ? `${clustersQuery.data.length} clusters tracked`
              : 'Capacity forecasts across all tracked clusters.'}
          </p>
```

Everything else in this file (imports, queries, empty state, error card, skeleton, table render) stays as-is. The component function name `DashboardPage` can stay — internal name, no UX impact.

- [ ] **Step 2: Replace `routes/index.tsx` with the bento Overview.**

Replace the entire contents of `apps/web/src/routes/index.tsx` with:

```tsx
import type { ForecastResponse } from '@lcm/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';

import { ClusterTile } from '@/components/overview/cluster-tile';
import { FleetCapacityChart } from '@/components/overview/fleet-capacity-chart';
import { KpiTile } from '@/components/overview/kpi-tile';
import { Card } from '@/components/ui/card';
import { aggregateFleet } from '@/lib/aggregate-fleet';
import { api } from '@/lib/api-client';

export const Route = createFileRoute('/')({
  component: OverviewPage,
});

function OverviewPage(): React.JSX.Element {
  const clustersQuery = useQuery({
    queryKey: ['clusters'],
    queryFn: () => api.clusters.list(),
  });

  const clusters = clustersQuery.data ?? [];

  // Fan out one 24-month forecast query per cluster — uses the same queryKey
  // shape as the detail page so cache is shared.
  const forecastQueries = useQueries({
    queries: clusters.map((cluster) => {
      const metric = cluster.metrics[0];
      const range = computeWindow(cluster.baselineDate, 24);
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

  const summary = aggregateFleet(clusters, forecastEntries);

  const isLoading = clustersQuery.isPending;
  const isError = clustersQuery.isError;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Overview
        </p>
        <h1 className="text-[1.625rem] font-semibold tracking-tight">Fleet</h1>
      </header>

      {isLoading ? <OverviewSkeleton /> : null}

      {isError ? (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Could not load clusters: {clustersQuery.error?.message}</span>
        </Card>
      ) : null}

      {!isLoading && !isError && clusters.length === 0 ? (
        <Card className="border-dashed p-8 text-center text-sm text-muted-foreground">
          No clusters yet. Add one from the Clusters page to see fleet overview.
        </Card>
      ) : null}

      {!isLoading && !isError && clusters.length > 0 ? (
        <div className="grid grid-cols-12 gap-4">
          <KpiTile
            className="col-span-12 sm:col-span-4"
            label="Fleet utilization"
            value={`${(summary.utilization * 100).toFixed(1)}%`}
            caption="memory used"
            status={
              summary.utilization >= 0.9 ? 'crit' : summary.utilization >= 0.7 ? 'warn' : 'ok'
            }
          />
          <KpiTile
            className="col-span-12 sm:col-span-4"
            label="Clusters tracked"
            value={String(summary.clusterCount)}
            caption={`${forecastQueries.filter((q) => q.isSuccess).length} responsive`}
            status="ok"
          />
          <KpiTile
            className="col-span-12 sm:col-span-4"
            label="Worst cluster"
            value={summary.worstCluster?.name ?? '—'}
            caption={
              summary.worstCluster
                ? `${(summary.worstCluster.utilization * 100).toFixed(1)}% utilization`
                : 'no data'
            }
            status={
              summary.worstCluster && summary.worstCluster.utilization >= 0.9
                ? 'crit'
                : summary.worstCluster && summary.worstCluster.utilization >= 0.7
                  ? 'warn'
                  : 'ok'
            }
          />

          <Card className="col-span-12 p-4">
            <FleetCapacityChart
              fleetMonths={summary.fleetMonths}
              clusters={summary.perClusterSeries.map((s) => ({
                clusterId: s.clusterId,
                clusterName: s.clusterName,
              }))}
            />
          </Card>

          {summary.perClusterSeries.map((series) => {
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
          })}
        </div>
      ) : null}
    </div>
  );
}

function computeWindow(baselineDate: string, months: number): { from: string; to: string } {
  const baseline = new Date(`${baselineDate}T00:00:00Z`);
  const half = Math.floor(months / 2);
  const from = new Date(baseline);
  from.setUTCMonth(from.getUTCMonth() - half);
  const to = new Date(baseline);
  to.setUTCMonth(to.getUTCMonth() + (months - half));
  return {
    from: `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}-01`,
    to: `${to.getUTCFullYear()}-${String(to.getUTCMonth() + 1).padStart(2, '0')}-01`,
  };
}

function OverviewSkeleton(): React.JSX.Element {
  return (
    <div className="grid grid-cols-12 gap-4">
      <Card className="col-span-12 h-24 animate-pulse sm:col-span-4" />
      <Card className="col-span-12 h-24 animate-pulse sm:col-span-4" />
      <Card className="col-span-12 h-24 animate-pulse sm:col-span-4" />
      <Card className="col-span-12 h-[320px] animate-pulse" />
      <Card className="col-span-12 h-32 animate-pulse md:col-span-6" />
      <Card className="col-span-12 h-32 animate-pulse md:col-span-6" />
    </div>
  );
}
```

- [ ] **Step 3: Update `sidebar.tsx` nav items.**

In `apps/web/src/components/layout/sidebar.tsx`, the current imports look like:

```tsx
import { ChevronsLeft, ChevronsRight, LayoutDashboard, Settings } from 'lucide-react';
```

Change to:

```tsx
import { ChevronsLeft, ChevronsRight, Database, LayoutPanelLeft, Settings } from 'lucide-react';
```

Then replace the `navItems` array (currently lines ~9–12):

```tsx
const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/settings', label: 'Settings', icon: Settings, exact: false },
] as const;
```

With:

```tsx
const navItems = [
  { to: '/', label: 'Overview', icon: LayoutPanelLeft, exact: true },
  { to: '/clusters', label: 'Clusters', icon: Database, exact: false },
  { to: '/settings', label: 'Settings', icon: Settings, exact: false },
] as const;
```

- [ ] **Step 4: Update `breadcrumbs.tsx` path patterns.**

In `apps/web/src/components/layout/breadcrumbs.tsx`, find the crumbs derivation IIFE (currently around lines 41–53). Replace it with:

```tsx
const crumbs: Crumb[] = (() => {
  if (path === '/' || path === '') {
    return [{ label: 'Overview' }];
  }
  if (path.startsWith('/clusters/new')) {
    return [{ label: 'Clusters', to: '/clusters' }, { label: 'New cluster' }];
  }
  if (path.startsWith('/clusters/') && clusterId) {
    return [{ label: 'Clusters', to: '/clusters' }, clusterCrumb];
  }
  if (path === '/clusters' || path.startsWith('/clusters')) {
    return [{ label: 'Clusters' }];
  }
  if (path.startsWith('/settings')) {
    return [{ label: 'Settings' }];
  }
  return [{ label: 'Overview', to: '/' }];
})();
```

The fallback at the bottom now points to Overview (was Dashboard).

- [ ] **Step 5: Update `command-palette.tsx` Navigation items.**

In `apps/web/src/components/command/command-palette.tsx`, the imports near the top include:

```tsx
import {
  LayoutDashboard,
  Monitor,
  Moon,
  Plus,
  Server,
  Settings,
  Sun,
  type LucideIcon,
} from 'lucide-react';
```

Change to:

```tsx
import {
  Database,
  LayoutPanelLeft,
  Monitor,
  Moon,
  Plus,
  Server,
  Settings,
  Sun,
  type LucideIcon,
} from 'lucide-react';
```

Find the Navigation `PaletteGroup` (currently two `PaletteItem` children, "Go to dashboard" and "Go to settings"). Replace with three items:

```tsx
<PaletteGroup heading="Navigation">
  <PaletteItem
    icon={LayoutPanelLeft}
    label="Go to overview"
    hint="g o"
    onSelect={() => runAndClose(() => navigate({ to: '/' }))}
  />
  <PaletteItem
    icon={Database}
    label="Go to clusters"
    hint="g c"
    onSelect={() => runAndClose(() => navigate({ to: '/clusters' }))}
  />
  <PaletteItem
    icon={Settings}
    label="Go to settings"
    hint="g s"
    onSelect={() => runAndClose(() => navigate({ to: '/settings' }))}
  />
</PaletteGroup>
```

- [ ] **Step 6: Update `keyboard-shortcuts.tsx`.**

In `apps/web/src/components/command/keyboard-shortcuts.tsx`, find the `g`-prefix branch:

```tsx
if (pendingPrefix.current === 'g') {
  if (event.key === 'd') {
    event.preventDefault();
    navigate({ to: '/' });
  } else if (event.key === 's') {
    event.preventDefault();
    navigate({ to: '/settings' });
  }
  clearPrefix();
  return;
}
```

Replace with:

```tsx
if (pendingPrefix.current === 'g') {
  if (event.key === 'o') {
    event.preventDefault();
    navigate({ to: '/' });
  } else if (event.key === 'c') {
    event.preventDefault();
    navigate({ to: '/clusters' });
  } else if (event.key === 's') {
    event.preventDefault();
    navigate({ to: '/settings' });
  }
  clearPrefix();
  return;
}
```

- [ ] **Step 7: Update `shortcuts-dialog.tsx`.**

In `apps/web/src/components/command/shortcuts-dialog.tsx`, replace the `ROWS` constant:

```tsx
const ROWS: Row[] = [
  { keys: ['⌘', 'K'], label: 'Open command palette' },
  { keys: ['?'], label: 'Show this shortcuts list' },
  { keys: ['Esc'], label: 'Close any modal' },
  { keys: ['g', 'd'], label: 'Go to dashboard' },
  { keys: ['g', 's'], label: 'Go to settings' },
];
```

With:

```tsx
const ROWS: Row[] = [
  { keys: ['⌘', 'K'], label: 'Open command palette' },
  { keys: ['?'], label: 'Show this shortcuts list' },
  { keys: ['Esc'], label: 'Close any modal' },
  { keys: ['g', 'o'], label: 'Go to overview' },
  { keys: ['g', 'c'], label: 'Go to clusters' },
  { keys: ['g', 's'], label: 'Go to settings' },
];
```

- [ ] **Step 8: Verify build + typecheck + lint.**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web build
```

Expected: all pass. TanStack Router's plugin regenerates `routeTree.gen.ts` automatically during the build.

- [ ] **Step 9: Commit.**

```bash
git add apps/web/src/routes/index.tsx apps/web/src/routes/clusters.index.tsx apps/web/src/components/layout/sidebar.tsx apps/web/src/components/layout/breadcrumbs.tsx apps/web/src/components/command/command-palette.tsx apps/web/src/components/command/keyboard-shortcuts.tsx apps/web/src/components/command/shortcuts-dialog.tsx
git commit -m "feat(web): bento Overview at /, table moves to /clusters

Adds the bento Overview as the default landing page: KPI tiles (fleet
util, cluster count, worst cluster), stacked-area fleet capacity chart,
and clickable cluster tiles in a 2x2 grid. Per-cluster forecasts are
fanned out via useQueries and aggregated client-side via aggregateFleet.
Old dashboard table moves verbatim to /clusters. Sidebar reordered
Overview / Clusters / Settings with LayoutPanelLeft + Database icons.
Breadcrumbs, command palette, and keyboard shortcuts (g o / g c / g s)
all updated to match."
```

---

## Task 4 — Test + e2e updates, full verification

**Files:**

- Modify: `apps/web/src/__tests__/keyboard-shortcuts.test.tsx`
- Modify: `apps/web/playwright/golden-path.spec.ts`

**Goal:** Update the two tests that depend on the old route layout, then run the full verification gauntlet.

- [ ] **Step 1: Update `keyboard-shortcuts.test.tsx` to assert against `/clusters` and `/settings`.**

The current test has two cases — `g s` → `/settings` and `g d` → `/`. Update the test router and assertions for the new shortcuts.

Replace the entire `buildRouter` function and the test cases. Open `apps/web/src/__tests__/keyboard-shortcuts.test.tsx`.

Find `buildRouter`:

```tsx
function buildRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <KeyboardShortcuts />
        <div data-testid="here" />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div data-testid="dashboard">Dashboard</div>,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => <div data-testid="settings">Settings</div>,
  });
  const routeTree = rootRoute.addChildren([indexRoute, settingsRoute]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
}
```

Change the `path: '/'` route's content marker and add a `/clusters` route:

```tsx
function buildRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <KeyboardShortcuts />
        <div data-testid="here" />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div data-testid="overview">Overview</div>,
  });
  const clustersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/clusters',
    component: () => <div data-testid="clusters">Clusters</div>,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => <div data-testid="settings">Settings</div>,
  });
  const routeTree = rootRoute.addChildren([indexRoute, clustersRoute, settingsRoute]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
}
```

Now find the test bodies. Currently:

```tsx
test('g s navigates to /settings', async () => {
  const user = userEvent.setup();
  const router = buildRouter();
  render(wrap(router));

  await user.keyboard('g');
  await user.keyboard('s');

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(router.state.location.pathname).toBe('/settings');
});

test('g d navigates to /', async () => {
  const user = userEvent.setup();
  const router = buildRouter();
  render(wrap(router));

  await router.navigate({ to: '/settings' });

  await user.keyboard('g');
  await user.keyboard('d');

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(router.state.location.pathname).toBe('/');
});
```

Replace with:

```tsx
test('g c navigates to /clusters', async () => {
  const user = userEvent.setup();
  const router = buildRouter();
  render(wrap(router));

  await user.keyboard('g');
  await user.keyboard('c');

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(router.state.location.pathname).toBe('/clusters');
});

test('g o navigates to /', async () => {
  const user = userEvent.setup();
  const router = buildRouter();
  render(wrap(router));

  await router.navigate({ to: '/settings' });

  await user.keyboard('g');
  await user.keyboard('o');

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(router.state.location.pathname).toBe('/');
});
```

(`g s` is implicitly still covered by the implementation; if you want a third explicit case, add one mirroring the `g c` test with `s` → `/settings`. Keep the suite to 2 tests for parity with the prior test count and to limit churn.)

- [ ] **Step 2: Update `playwright/golden-path.spec.ts` to start at `/clusters`.**

The spec opens `/` and clicks the "+ Add cluster" button. Under the new structure that button is on `/clusters`. Open `apps/web/playwright/golden-path.spec.ts`.

Find:

```ts
await page.goto('/');
await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
```

Replace with:

```ts
await page.goto('/clusters');
await expect(page.getByRole('heading', { name: 'Clusters', level: 1 })).toBeVisible();
```

(The h1 text was already "Dashboard" → "Clusters" per Task 3 Step 1.)

The theme-toggle assertions at the end of the test are route-independent — leave them as-is.

- [ ] **Step 3: Run full test suite + typecheck + lint + build.**

```bash
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
pnpm --filter @lcm/web build
```

Expected: 23 unit tests pass (18 prior + 5 new aggregate-fleet), typecheck clean, build clean.

- [ ] **Step 4: Run Playwright if the dev stack is up.**

If `apps/api` and `apps/web` are already running (check `curl -sf http://localhost:8090/readyz` and `curl -sf http://localhost:5173`), run:

```bash
pnpm --filter @lcm/web test:e2e
```

Expected: golden-path passes including the theme-cycle assertions.

If the dev servers aren't running, skip this step and rely on the unit suite. Note in the commit message that e2e was not run if so.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/__tests__/keyboard-shortcuts.test.tsx apps/web/playwright/golden-path.spec.ts
git commit -m "test(web): update shortcuts + e2e for /clusters move

keyboard-shortcuts test now asserts g c → /clusters and g o → /
against a real memory router. Playwright golden path opens /clusters
(was /) and expects the Clusters h1 (was Dashboard)."
```

---

## Acceptance verification

After Task 4 commits, walk the running app and confirm:

1. ☐ `/` renders bento Overview: "Overview" eyebrow + "Fleet" h1; 3 KPI tiles; full-width fleet capacity chart with one color per cluster; 2x2 grid of clickable cluster tiles below.
2. ☐ Clicking a cluster tile opens its detail page at `/clusters/$id`.
3. ☐ `/clusters` shows the cluster table (previously at `/`).
4. ☐ Sidebar order: Overview · Clusters · Settings. Each highlights when its route is active.
5. ☐ Breadcrumb on `/` reads "Overview"; on `/clusters` reads "Clusters"; on `/clusters/$id` reads "Clusters › {name}".
6. ☐ `g o` / `g c` / `g s` navigate correctly; `g d` does nothing.
7. ☐ ⌘K palette Navigation group lists "Go to overview / clusters / settings" with the new hints.
8. ☐ `?` dialog shows 6 rows including all three `g _` shortcuts.
9. ☐ Theme toggle still works; bento repaints cleanly on light↔dark.
10. ☐ Window resize: bento collapses 12 → 2 → 1 col gracefully.
11. ☐ `git diff main --stat`: only `apps/web/**` + `docs/superpowers/{specs,plans}/2026-05-23-bento-overview*.md` are touched.

---

## Notes for the executor

- **The hardest piece is `FleetCapacityChart`'s tooltip.** Recharts passes `payload` with one entry per `<Area>` plus the `<Line>`. The implementation finds each by `dataKey` — exact match on the cluster ID and `'capacityTotal'`. If the tooltip looks wrong, log `payload` to console and check the data keys.
- **Per-cluster colors are stable** because `aggregateFleet` sorts clusters by ID and the chart maps `idx % clusterPalette.length`. Adding/removing clusters reshuffles colors only if the ID sort order changes.
- **`useQueries` over per-cluster forecasts shares cache** with the detail page (`queryKey: ['forecast', id, ...]`). Navigating between Overview and detail uses cached data.
- **Husky pre-commit** runs Prettier + `pnpm -r typecheck`. If something fails, fix and re-stage; don't `--amend`.
- **`routes/clusters.index.tsx`** uses TanStack's `createFileRoute('/clusters/')`. The plugin treats this as an index segment for the `/clusters` path. The plugin will regenerate `routeTree.gen.ts`; no manual codegen step.
- **Sparkline width on the cluster tile is `240px`.** That's wider than the previous table-cell sparkline (`120px`); fits the wider tile container. Height stays small (36px). Adjust if visual feels off.
- **Empty state at `/`** uses a plain dashed Card. The seed-data convenience that lived in the old empty-state lives on `/clusters` (since `clusters.index.tsx` inherits the old empty-state). From the Overview, the message points users to `/clusters` to add their first cluster.
