# Overview fleet charts redesign — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stacked-area `FleetCapacityChart` on the Overview route (`/`) with a small-multiples per-cluster utilization grid plus a cluster × month threshold-stepped heatmap, so each cluster's pressure is visible regardless of fleet size.

**Architecture:** The route precomputes a shared `ClusterForecastEntry[]` (cluster, months, thresholds, runway summary) and passes it to two new presentational components: `FleetClusterGrid` (which renders one `FleetClusterTileChart` per cluster, sorted worst-runway-first) and `FleetUtilizationHeatmap` (cluster × month grid, sorted worst-current-utilization-first). The old stacked chart, its grayscale `clusterPalette`, and the now-redundant `ClusterTile` strip are deleted.

**Tech Stack:** React 19, TanStack Router/Query, Recharts 2.15, Tailwind v4, Vitest, Testing Library. Tests live next to components as `*.test.tsx` and mock Recharts components with `data-testid` stubs (pattern: `apps/web/src/components/clusters/forecast-chart.test.tsx`).

**Spec:** `docs/superpowers/specs/2026-05-25-overview-fleet-charts-redesign.md`.

---

## File map

**Create:**

- `apps/web/src/components/overview/fleet-cluster-tile-chart.tsx` (+ test)
- `apps/web/src/components/overview/fleet-cluster-grid.tsx` (+ test)
- `apps/web/src/components/overview/fleet-utilization-heatmap.tsx` (+ test)

**Modify:**

- `apps/web/src/lib/forecast-summary.ts` — export `ClusterForecastEntry` + `buildClusterForecastEntries()` helper.
- `apps/web/src/routes/index.tsx` — swap the chart block; build entries via the new helper; pass to both new components; drop the `ClusterTile` loop and stale `thresholdsByCluster` map.
- `apps/web/src/lib/use-chart-colors.ts` — remove `clusterPalette` field + values (light + dark).

**Delete:**

- `apps/web/src/components/overview/fleet-capacity-chart.tsx`
- `apps/web/src/components/overview/cluster-tile.tsx`
- `apps/web/src/components/overview/cluster-tile.test.tsx`

---

## Task 1 — Shared `ClusterForecastEntry` type + builder

**Files:**

- Modify: `apps/web/src/lib/forecast-summary.ts`
- Test: `apps/web/src/lib/forecast-summary.test.ts` (create if missing — see step 1)

### Steps

- [ ] **Step 1: Check whether a test file exists**

```bash
ls apps/web/src/lib/forecast-summary.test.ts 2>/dev/null || echo "MISSING"
```

If MISSING, create it with this header:

```ts
import type { ClusterResponse } from '@lcm/shared';
import { describe, expect, it } from 'vitest';

import { buildClusterForecastEntries } from './forecast-summary';
```

- [ ] **Step 2: Write failing tests**

Append to `apps/web/src/lib/forecast-summary.test.ts`:

```ts
function makeCluster(name: string, utilization = 0.4): ClusterResponse {
  return {
    id: `c-${name}`,
    name,
    description: null,
    baselineDate: '2026-05-01',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    archivedAt: null,
    metrics: [
      {
        metricTypeKey: 'memory_gb',
        metricTypeDisplayName: 'Memory',
        unit: 'GB',
        baselineConsumption: 400,
        baselineCapacity: 1000,
        currentConsumption: utilization * 1000,
        currentCapacity: 1000,
        utilization,
      },
    ],
  };
}

describe('buildClusterForecastEntries', () => {
  it('omits clusters that have no forecast yet (still loading)', () => {
    const a = makeCluster('A');
    const b = makeCluster('B');
    const entries = buildClusterForecastEntries([a, b], {
      [a.id]: {
        months: [{ month: '2026-05-01', consumption: 400, capacity: 1000, utilization: 0.4 }],
        thresholds: { warn: 0.7, crit: 0.9 },
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.cluster.id).toBe(a.id);
  });

  it('computes a runway summary per cluster from its months + thresholds', () => {
    const a = makeCluster('A');
    const entries = buildClusterForecastEntries([a], {
      [a.id]: {
        months: [
          { month: '2026-05-01', consumption: 400, capacity: 1000, utilization: 0.4 },
          { month: '2026-06-01', consumption: 800, capacity: 1000, utilization: 0.8 },
        ],
        thresholds: { warn: 0.7, crit: 0.9 },
      },
    });
    // Util crosses warn (0.7) at index 1, so months = 1.
    expect(entries[0]?.summary).toEqual({ months: 1, alreadyBreached: false });
  });

  it('uses cluster-specific thresholds when computing runway, not the system defaults', () => {
    const a = makeCluster('A');
    const entries = buildClusterForecastEntries([a], {
      [a.id]: {
        months: [{ month: '2026-05-01', consumption: 460, capacity: 1000, utilization: 0.46 }],
        // Custom 45/48 thresholds — 0.46 is already over warn.
        thresholds: { warn: 0.45, crit: 0.48 },
      },
    });
    expect(entries[0]?.summary).toEqual({ months: 0, alreadyBreached: 'warn' });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter @lcm/web test --run forecast-summary
```

Expected: FAIL with `buildClusterForecastEntries is not a function` (or similar import error).

- [ ] **Step 4: Implement the builder**

Append to `apps/web/src/lib/forecast-summary.ts`:

```ts
import type { ClusterResponse } from '@lcm/shared';

export interface ClusterForecastEntry {
  cluster: ClusterResponse;
  months: ForecastMonthPoint[];
  thresholds: { warn: number; crit: number };
  summary: RunwaySummary;
}

export interface ClusterForecastSource {
  months: ForecastMonthPoint[];
  thresholds: { warn: number; crit: number };
}

export function buildClusterForecastEntries(
  clusters: ClusterResponse[],
  forecastsById: Record<string, ClusterForecastSource | undefined>,
): ClusterForecastEntry[] {
  const entries: ClusterForecastEntry[] = [];
  for (const cluster of clusters) {
    const source = forecastsById[cluster.id];
    if (!source) continue;
    entries.push({
      cluster,
      months: source.months,
      thresholds: source.thresholds,
      summary: runwayToWarn(source.months, source.thresholds),
    });
  }
  return entries;
}
```

The `ClusterResponse` import goes at the top of the file with the existing `ForecastMonthPoint` import.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @lcm/web test --run forecast-summary
```

Expected: PASS — 3 new tests pass; any pre-existing tests in this file (if any) still pass.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @lcm/web typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/forecast-summary.ts apps/web/src/lib/forecast-summary.test.ts
git commit -m "$(cat <<'EOF'
feat(web): Add ClusterForecastEntry builder for fleet views

Single helper that combines per-cluster months, effective thresholds
and the computed runway summary, so the upcoming small-multiples grid
and utilization heatmap can share one precomputed shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — `FleetClusterTileChart` component

**Files:**

- Create: `apps/web/src/components/overview/fleet-cluster-tile-chart.tsx`
- Test: `apps/web/src/components/overview/fleet-cluster-tile-chart.test.tsx`

### Steps

- [ ] **Step 1: Write failing tests**

Create `apps/web/src/components/overview/fleet-cluster-tile-chart.test.tsx`:

```tsx
import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ClusterForecastEntry } from '@/lib/forecast-summary';

import { FleetClusterTileChart } from './fleet-cluster-tile-chart';

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

vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }): React.JSX.Element => <>{children}</>;
  return {
    ResponsiveContainer: Pass,
    LineChart: ({ data, children }: { data: unknown; children?: React.ReactNode }) => (
      <div data-testid="chart" data-rows={JSON.stringify(data)}>
        {children}
      </div>
    ),
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Line: ({ dataKey }: { dataKey: string }) => <div data-testid={`line-${dataKey}`} />,
    ReferenceArea: ({ y1, y2 }: { y1: number; y2: number }) => (
      <div data-testid="reference-area" data-y1={y1} data-y2={y2} />
    ),
  };
});

const cluster: ClusterResponse = {
  id: 'c1',
  name: 'CL-Test',
  description: null,
  baselineDate: '2026-05-01',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  archivedAt: null,
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
  { month: '2026-06-01', consumption: 800, capacity: 1000, utilization: 0.8 },
];

function entry(overrides: Partial<ClusterForecastEntry> = {}): ClusterForecastEntry {
  return {
    cluster,
    months,
    thresholds: { warn: 0.7, crit: 0.9 },
    summary: { months: 1, alreadyBreached: false },
    ...overrides,
  };
}

describe('<FleetClusterTileChart>', () => {
  it('renders the cluster name, a runway pill using cluster thresholds, and a utilization line', () => {
    render(<FleetClusterTileChart entry={entry()} />);
    expect(screen.getByText('CL-Test')).toBeInTheDocument();
    // The pill formats the projected runway using the cluster's warn threshold (70%).
    expect(screen.getByText(/1 mo to 70%/i)).toBeInTheDocument();
    expect(screen.getByTestId('line-util')).toBeInTheDocument();
  });

  it('uses the cluster-specific thresholds for the runway pill label', () => {
    render(
      <FleetClusterTileChart
        entry={entry({
          thresholds: { warn: 0.45, crit: 0.48 },
          summary: { months: 0, alreadyBreached: 'warn' },
        })}
      />,
    );
    expect(screen.getByText(/Over 45%/i)).toBeInTheDocument();
  });

  it('feeds the chart utilization values per month (consumption / capacity)', () => {
    render(<FleetClusterTileChart entry={entry()} />);
    const rows = JSON.parse(screen.getByTestId('chart').dataset.rows ?? '[]') as Array<{
      month: string;
      util: number;
    }>;
    expect(rows).toEqual([
      { month: '2026-05-01', util: 0.4 },
      { month: '2026-06-01', util: 0.8 },
    ]);
  });

  it('renders two threshold bands at warn..crit and crit..1', () => {
    render(<FleetClusterTileChart entry={entry()} />);
    const bands = screen.getAllByTestId('reference-area');
    expect(bands).toHaveLength(2);
    expect(bands[0]?.dataset.y1).toBe('0.7');
    expect(bands[0]?.dataset.y2).toBe('0.9');
    expect(bands[1]?.dataset.y1).toBe('0.9');
    expect(bands[1]?.dataset.y2).toBe('1');
  });

  it('wraps the tile in a link to the cluster detail page', () => {
    render(<FleetClusterTileChart entry={entry()} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/clusters/c1');
  });

  it('renders "No forecast" body when the cluster has no months', () => {
    render(<FleetClusterTileChart entry={entry({ months: [] })} />);
    expect(screen.getByText('CL-Test')).toBeInTheDocument();
    expect(screen.getByText(/No forecast/i)).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @lcm/web test --run fleet-cluster-tile-chart
```

Expected: FAIL with module-not-found for `./fleet-cluster-tile-chart`.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/overview/fleet-cluster-tile-chart.tsx`:

```tsx
import { Link } from '@tanstack/react-router';
import * as React from 'react';
import {
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card } from '@/components/ui/card';
import { RunwayPill } from '@/components/ui/runway-pill';
import { useChartColors } from '@/lib/use-chart-colors';
import type { ClusterForecastEntry } from '@/lib/forecast-summary';

interface FleetClusterTileChartProps {
  entry: ClusterForecastEntry;
}

function formatMonth(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

export function FleetClusterTileChart({ entry }: FleetClusterTileChartProps): React.JSX.Element {
  const { cluster, months, thresholds, summary } = entry;
  const colors = useChartColors();
  const data = months.map((m) => ({
    month: m.month,
    util: m.capacity > 0 ? m.consumption / m.capacity : 0,
  }));
  const hasData = data.length > 0;

  return (
    <Link
      to="/clusters/$id"
      params={{ id: cluster.id }}
      className="block rounded-[var(--radius-card)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card className="flex h-[180px] flex-col gap-2 p-3.5 transition-colors hover:border-fg-subtle/40">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 truncate text-sm font-semibold tracking-tight">{cluster.name}</h3>
          <RunwayPill summary={summary} horizonMonths={months.length} thresholds={thresholds} />
        </div>
        {hasData ? (
          <div className="h-[110px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <YAxis hide domain={[0, 1]} />
                <XAxis dataKey="month" hide />
                <ReferenceArea
                  y1={thresholds.warn}
                  y2={thresholds.crit}
                  fill={colors.utilizationWarn}
                  fillOpacity={0.1}
                  stroke="none"
                />
                <ReferenceArea
                  y1={thresholds.crit}
                  y2={1}
                  fill={colors.utilizationCrit}
                  fillOpacity={0.12}
                  stroke="none"
                />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0 || typeof label !== 'string') {
                      return null;
                    }
                    const util = (payload[0]?.value as number) ?? 0;
                    return (
                      <div className="rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-[var(--overlay-shadow)]">
                        <span className="font-medium">{formatMonth(label)}</span>
                        <span className="ml-2 font-mono tabular-nums">
                          {(util * 100).toFixed(1)}%
                        </span>
                      </div>
                    );
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="util"
                  stroke={colors.consumption}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-[110px] items-center justify-center text-xs text-fg-muted">
            No forecast
          </div>
        )}
      </Card>
    </Link>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @lcm/web test --run fleet-cluster-tile-chart
```

Expected: PASS — all 6 tests pass.

- [ ] **Step 5: Typecheck + lint**

```bash
pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint
```

Expected: no errors, no warnings.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/overview/fleet-cluster-tile-chart.tsx apps/web/src/components/overview/fleet-cluster-tile-chart.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): Add FleetClusterTileChart small-multiples tile

Per-cluster mini chart on a 0-100% utilization axis with cluster-
specific warn/crit reference bands and a RunwayPill header. Wrapped
in a TanStack Link so the whole tile navigates to the cluster detail
page.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — `FleetClusterGrid` component

**Files:**

- Create: `apps/web/src/components/overview/fleet-cluster-grid.tsx`
- Test: `apps/web/src/components/overview/fleet-cluster-grid.test.tsx`

### Steps

- [ ] **Step 1: Write failing tests**

Create `apps/web/src/components/overview/fleet-cluster-grid.test.tsx`:

```tsx
import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ClusterForecastEntry } from '@/lib/forecast-summary';

import { FleetClusterGrid } from './fleet-cluster-grid';

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
    return (
      <a href={href} data-testid="tile-link">
        {children}
      </a>
    );
  },
}));

// Stub recharts the same way the tile-chart test does — we only need to
// assert on which tiles render, not on chart internals.
vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }): React.JSX.Element => <>{children}</>;
  return {
    ResponsiveContainer: Pass,
    LineChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Line: () => null,
    ReferenceArea: () => null,
  };
});

function makeCluster(name: string): ClusterResponse {
  return {
    id: `c-${name}`,
    name,
    description: null,
    baselineDate: '2026-05-01',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    archivedAt: null,
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
}

const months: ForecastMonthPoint[] = [
  { month: '2026-05-01', consumption: 400, capacity: 1000, utilization: 0.4 },
];

function entry(name: string, summary: ClusterForecastEntry['summary']): ClusterForecastEntry {
  return {
    cluster: makeCluster(name),
    months,
    thresholds: { warn: 0.7, crit: 0.9 },
    summary,
  };
}

function visibleNamesInOrder(): string[] {
  return screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent ?? '');
}

describe('<FleetClusterGrid>', () => {
  it('sorts: already-crit, then already-warn, then ascending months-to-breach, then no-breach', () => {
    const entries: ClusterForecastEntry[] = [
      entry('no-breach', { months: null, alreadyBreached: false }),
      entry('crit-now', { months: 0, alreadyBreached: 'crit' }),
      entry('warn-in-3', { months: 3, alreadyBreached: false }),
      entry('warn-now', { months: 0, alreadyBreached: 'warn' }),
      entry('warn-in-1', { months: 1, alreadyBreached: false }),
    ];
    render(<FleetClusterGrid entries={entries} />);
    expect(visibleNamesInOrder()).toEqual([
      'crit-now',
      'warn-now',
      'warn-in-1',
      'warn-in-3',
      'no-breach',
    ]);
  });

  it('breaks ties on the sort key alphabetically by cluster name', () => {
    const entries: ClusterForecastEntry[] = [
      entry('Beta', { months: 2, alreadyBreached: false }),
      entry('Alpha', { months: 2, alreadyBreached: false }),
    ];
    render(<FleetClusterGrid entries={entries} />);
    expect(visibleNamesInOrder()).toEqual(['Alpha', 'Beta']);
  });

  it('renders a skeleton grid when isLoading and no entries are given', () => {
    render(<FleetClusterGrid entries={[]} isLoading />);
    expect(screen.getByTestId('grid-skeleton')).toBeInTheDocument();
  });

  it('renders nothing for an empty non-loading entries list', () => {
    const { container } = render(<FleetClusterGrid entries={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @lcm/web test --run fleet-cluster-grid
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/overview/fleet-cluster-grid.tsx`:

```tsx
import * as React from 'react';

import { Card } from '@/components/ui/card';
import type { ClusterForecastEntry } from '@/lib/forecast-summary';

import { FleetClusterTileChart } from './fleet-cluster-tile-chart';

interface FleetClusterGridProps {
  entries: ClusterForecastEntry[];
  isLoading?: boolean;
}

const SKELETON_COUNT = 4;

function sortKey(entry: ClusterForecastEntry): number {
  if (entry.summary.alreadyBreached === 'crit') return -2;
  if (entry.summary.alreadyBreached === 'warn') return -1;
  if (entry.summary.months !== null) return entry.summary.months;
  return Number.POSITIVE_INFINITY;
}

export function FleetClusterGrid({
  entries,
  isLoading = false,
}: FleetClusterGridProps): React.JSX.Element | null {
  if (isLoading && entries.length === 0) {
    return (
      <div
        data-testid="grid-skeleton"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      >
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          <Card key={i} className="h-[180px] animate-pulse" />
        ))}
      </div>
    );
  }
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka !== kb) return ka - kb;
    return a.cluster.name.localeCompare(b.cluster.name);
  });
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {sorted.map((entry) => (
        <FleetClusterTileChart key={entry.cluster.id} entry={entry} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @lcm/web test --run fleet-cluster-grid
```

Expected: PASS — 4 tests pass.

- [ ] **Step 5: Typecheck + lint**

```bash
pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint
```

Expected: no errors, no warnings.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/overview/fleet-cluster-grid.tsx apps/web/src/components/overview/fleet-cluster-grid.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): Add FleetClusterGrid small-multiples container

Sorts the per-cluster tiles worst-runway-first: already-crit, then
already-warn, then ascending months-to-breach, then no-breach.
Alphabetical tie-break. Renders skeleton tiles while forecasts load.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 — `FleetUtilizationHeatmap` component

**Files:**

- Create: `apps/web/src/components/overview/fleet-utilization-heatmap.tsx`
- Test: `apps/web/src/components/overview/fleet-utilization-heatmap.test.tsx`

### Steps

- [ ] **Step 1: Write failing tests**

Create `apps/web/src/components/overview/fleet-utilization-heatmap.test.tsx`:

```tsx
import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ClusterForecastEntry } from '@/lib/forecast-summary';

import { FleetUtilizationHeatmap } from './fleet-utilization-heatmap';

function makeCluster(name: string, utilization: number): ClusterResponse {
  return {
    id: `c-${name}`,
    name,
    description: null,
    baselineDate: '2026-05-01',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    archivedAt: null,
    metrics: [
      {
        metricTypeKey: 'memory_gb',
        metricTypeDisplayName: 'Memory',
        unit: 'GB',
        baselineConsumption: utilization * 1000,
        baselineCapacity: 1000,
        currentConsumption: utilization * 1000,
        currentCapacity: 1000,
        utilization,
      },
    ],
  };
}

function entry(
  name: string,
  months: ForecastMonthPoint[],
  thresholds = { warn: 0.7, crit: 0.9 },
  currentUtilization = 0.4,
): ClusterForecastEntry {
  return {
    cluster: makeCluster(name, currentUtilization),
    months,
    thresholds,
    summary: { months: null, alreadyBreached: false },
  };
}

describe('<FleetUtilizationHeatmap>', () => {
  it('renders one row per cluster sorted by current utilization desc', () => {
    const entries: ClusterForecastEntry[] = [
      entry('Low', [], undefined, 0.2),
      entry('Hot', [], undefined, 0.92),
      entry('Mid', [], undefined, 0.55),
    ];
    render(<FleetUtilizationHeatmap entries={entries} />);
    const rowHeaders = screen.getAllByRole('rowheader').map((h) => h.textContent);
    expect(rowHeaders).toEqual(['Hot', 'Mid', 'Low']);
  });

  it('breaks ties on current utilization alphabetically by cluster name', () => {
    const entries: ClusterForecastEntry[] = [
      entry('Beta', [], undefined, 0.5),
      entry('Alpha', [], undefined, 0.5),
    ];
    render(<FleetUtilizationHeatmap entries={entries} />);
    const rowHeaders = screen.getAllByRole('rowheader').map((h) => h.textContent);
    expect(rowHeaders).toEqual(['Alpha', 'Beta']);
  });

  it("colors cells by utStatus using the cluster's own thresholds", () => {
    const months: ForecastMonthPoint[] = [
      { month: '2026-05-01', consumption: 460, capacity: 1000, utilization: 0.46 },
    ];
    // Cluster with custom 45/48 thresholds — 0.46 is already warn.
    const entries: ClusterForecastEntry[] = [
      entry('Custom', months, { warn: 0.45, crit: 0.48 }, 0.46),
    ];
    render(<FleetUtilizationHeatmap entries={entries} />);
    const cell = screen.getByTestId('cell-c-Custom-2026-05-01');
    expect(cell.dataset.status).toBe('warn');
  });

  it('marks months with no point for a cluster as empty', () => {
    const entries: ClusterForecastEntry[] = [
      entry('Sparse', [
        { month: '2026-05-01', consumption: 200, capacity: 1000, utilization: 0.2 },
      ]),
      entry('Dense', [
        { month: '2026-05-01', consumption: 200, capacity: 1000, utilization: 0.2 },
        { month: '2026-06-01', consumption: 200, capacity: 1000, utilization: 0.2 },
      ]),
    ];
    render(<FleetUtilizationHeatmap entries={entries} />);
    expect(screen.getByTestId('cell-c-Sparse-2026-06-01').dataset.status).toBe('empty');
  });

  it('gives each cell an aria-label with month, percent, and status', () => {
    const months: ForecastMonthPoint[] = [
      { month: '2026-05-01', consumption: 480, capacity: 1000, utilization: 0.48 },
    ];
    const entries: ClusterForecastEntry[] = [
      entry('Custom', months, { warn: 0.45, crit: 0.48 }, 0.48),
    ];
    render(<FleetUtilizationHeatmap entries={entries} />);
    expect(screen.getByLabelText(/May 2026 — 48\.0% \(crit\)/)).toBeInTheDocument();
  });

  it('renders a skeleton when isLoading and no entries are given', () => {
    render(<FleetUtilizationHeatmap entries={[]} isLoading />);
    expect(screen.getByTestId('heatmap-skeleton')).toBeInTheDocument();
  });

  it('renders nothing for an empty non-loading entries list', () => {
    const { container } = render(<FleetUtilizationHeatmap entries={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @lcm/web test --run fleet-utilization-heatmap
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/overview/fleet-utilization-heatmap.tsx`:

```tsx
import * as React from 'react';

import { Card } from '@/components/ui/card';
import type { ClusterForecastEntry } from '@/lib/forecast-summary';
import { utilStatus, type UtilStatus } from '@/lib/forecast-summary';

interface FleetUtilizationHeatmapProps {
  entries: ClusterForecastEntry[];
  isLoading?: boolean;
}

interface HeatmapCell {
  month: string;
  util: number | null;
  status: UtilStatus | 'empty';
}

const SKELETON_ROWS = 4;
const SKELETON_COLS = 12;

const STATUS_CLASS: Record<UtilStatus | 'empty', string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  crit: 'bg-destructive',
  empty: 'bg-muted',
};

function formatMonthShort(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

function formatMonthLong(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function currentUtilization(entry: ClusterForecastEntry): number {
  return entry.cluster.metrics[0]?.utilization ?? 0;
}

export function FleetUtilizationHeatmap({
  entries,
  isLoading = false,
}: FleetUtilizationHeatmapProps): React.JSX.Element | null {
  if (isLoading && entries.length === 0) {
    return (
      <Card data-testid="heatmap-skeleton" className="p-4">
        <div className="space-y-2">
          {Array.from({ length: SKELETON_ROWS }).map((_, r) => (
            <div key={r} className="flex items-center gap-1">
              <div className="h-3 w-24 animate-pulse rounded bg-muted" />
              {Array.from({ length: SKELETON_COLS }).map((_, c) => (
                <div key={c} className="h-3 w-3 animate-pulse rounded-sm bg-muted" />
              ))}
            </div>
          ))}
        </div>
      </Card>
    );
  }
  if (entries.length === 0) return null;

  const monthSet = new Set<string>();
  for (const entry of entries) for (const m of entry.months) monthSet.add(m.month);
  const months = Array.from(monthSet).sort();

  const sorted = [...entries].sort((a, b) => {
    const ua = currentUtilization(a);
    const ub = currentUtilization(b);
    if (ua !== ub) return ub - ua;
    return a.cluster.name.localeCompare(b.cluster.name);
  });

  const rows = sorted.map((entry) => {
    const byMonth = new Map(entry.months.map((m) => [m.month, m]));
    const cells: HeatmapCell[] = months.map((month) => {
      const point = byMonth.get(month);
      if (!point || point.capacity <= 0) return { month, util: null, status: 'empty' };
      const util = point.consumption / point.capacity;
      return { month, util, status: utilStatus(util, entry.thresholds) };
    });
    return { entry, cells };
  });

  return (
    <Card className="overflow-x-auto p-4">
      <table className="w-full border-separate border-spacing-1 text-xs">
        <caption className="sr-only">Fleet utilization heatmap (cluster by month)</caption>
        <thead>
          <tr>
            <th scope="col" className="text-left font-medium text-fg-muted">
              Cluster
            </th>
            {months.map((m, i) => (
              <th
                key={m}
                scope="col"
                className={
                  i % 3 === 0
                    ? 'text-center font-mono text-[10px] font-normal text-fg-muted'
                    : 'hidden text-center font-mono text-[10px] font-normal text-fg-muted md:table-cell'
                }
              >
                {formatMonthShort(m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ entry, cells }) => (
            <tr key={entry.cluster.id}>
              <th scope="row" className="whitespace-nowrap text-left font-medium text-foreground">
                {entry.cluster.name}
              </th>
              {cells.map((cell) => {
                const pct = cell.util === null ? null : (cell.util * 100).toFixed(1);
                const label =
                  pct === null
                    ? `${formatMonthLong(cell.month)} — no data`
                    : `${formatMonthLong(cell.month)} — ${pct}% (${cell.status})`;
                return (
                  <td
                    key={cell.month}
                    data-testid={`cell-${entry.cluster.id}-${cell.month}`}
                    data-status={cell.status}
                    aria-label={label}
                    title={label}
                    className="p-0"
                  >
                    <span
                      aria-hidden
                      className={`block h-3 w-3 rounded-sm md:h-3 md:w-3 ${STATUS_CLASS[cell.status]}`}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @lcm/web test --run fleet-utilization-heatmap
```

Expected: PASS — 7 tests pass.

- [ ] **Step 5: Typecheck + lint**

```bash
pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint
```

Expected: no errors, no warnings.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/overview/fleet-utilization-heatmap.tsx apps/web/src/components/overview/fleet-utilization-heatmap.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): Add FleetUtilizationHeatmap

Cluster x month threshold-stepped grid: each cell renders green / yellow
/ red against the cluster's own warn/crit thresholds. Rows sorted by
current utilization desc; sparse months render as muted "no data"
cells. Semantic <table> with aria-labels for screen readers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 — Wire new components into the Overview route

**Files:**

- Modify: `apps/web/src/routes/index.tsx`

### Steps

- [ ] **Step 1: Read the current file**

```bash
sed -n '1,180p' apps/web/src/routes/index.tsx
```

Confirm the chart block (currently around lines 149-175) matches: a `<Card className="col-span-12 p-4">` wrapping `<FleetCapacityChart …/>` and the `summary.perClusterSeries.map(...)` rendering `<ClusterTile …/>`.

- [ ] **Step 2: Replace the imports**

Remove these imports:

```ts
import { ClusterTile } from '@/components/overview/cluster-tile';
import { FleetCapacityChart } from '@/components/overview/fleet-capacity-chart';
import { useMediaQuery } from '@/lib/use-media-query';
```

Add these imports near the existing component imports:

```ts
import { FleetClusterGrid } from '@/components/overview/fleet-cluster-grid';
import { FleetUtilizationHeatmap } from '@/components/overview/fleet-utilization-heatmap';
import { buildClusterForecastEntries } from '@/lib/forecast-summary';
```

(Verify no other code in the file still references `useMediaQuery` before removing — search with grep. If it's still used, keep the import.)

- [ ] **Step 3: Remove the now-dead `isWide` + `thresholdsByCluster` code**

Delete lines that look like:

```ts
const isWide = useMediaQuery('(min-width: 640px)');
```

and the whole block that builds `thresholdsByCluster`:

```ts
const thresholdsByCluster = new Map<string, { warn: number; crit: number }>();
clusters.forEach((cluster, i) => {
  const data = forecastQueries[i]?.data as ForecastResponse | undefined;
  if (data) {
    thresholdsByCluster.set(cluster.id, {
      warn: data.effectiveThresholds.warn,
      crit: data.effectiveThresholds.crit,
    });
  }
});
```

- [ ] **Step 4: Build the shared entries inside the route**

Add `import { useMemo } from 'react';` near the other top-level imports.

Right after the existing `const summary = aggregateFleet(...)` line, add:

```ts
const forecastsById = useMemo(() => {
  const acc: Record<
    string,
    { months: ForecastMonthPoint[]; thresholds: { warn: number; crit: number } }
  > = {};
  clusters.forEach((cluster, i) => {
    const data = forecastQueries[i]?.data as ForecastResponse | undefined;
    if (data) {
      acc[cluster.id] = {
        months: data.months,
        thresholds: {
          warn: data.effectiveThresholds.warn,
          crit: data.effectiveThresholds.crit,
        },
      };
    }
  });
  return acc;
}, [clusters, forecastQueries]);

const clusterEntries = useMemo(
  () => buildClusterForecastEntries(clusters, forecastsById),
  [clusters, forecastsById],
);
const forecastsLoading = forecastQueries.some((q) => q.isPending);
```

If `ForecastMonthPoint` is not yet imported in this file, add it to the existing `import type { ForecastResponse } from '@lcm/shared';` line.

- [ ] **Step 5: Replace the chart Card block + ClusterTile loop**

Replace the entire block from `<Card className="col-span-12 p-4">` (the one containing `<FleetCapacityChart …/>`) through the end of the `summary.perClusterSeries.map(...)` (the one rendering `<ClusterTile …/>`) with:

```tsx
<div className="col-span-12">
  <FleetClusterGrid entries={clusterEntries} isLoading={forecastsLoading} />
</div>

<div className="col-span-12">
  <FleetUtilizationHeatmap entries={clusterEntries} isLoading={forecastsLoading} />
</div>
```

- [ ] **Step 6: Typecheck + lint**

```bash
pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint
```

Expected: no errors. If `useMediaQuery` is reported as unused-but-still-imported elsewhere, that's a pre-existing issue — fix only if it points to the file you just edited.

- [ ] **Step 7: Run the full web test suite**

```bash
pnpm --filter @lcm/web test --run
```

Expected: all tests pass. The deleted `ClusterTile` is still referenced by `cluster-tile.test.tsx`, which Task 6 deletes; for now that test should still pass against the as-yet-undeleted component.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/routes/index.tsx
git commit -m "$(cat <<'EOF'
feat(web): Wire FleetClusterGrid + FleetUtilizationHeatmap into /

Overview now renders two cluster-aware fleet views in place of the
stacked FleetCapacityChart and the per-cluster ClusterTile strip.
The route precomputes a single ClusterForecastEntry[] from the
existing forecast queries and feeds both new components from it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 — Delete the old chart, ClusterTile, and grayscale palette

**Files:**

- Delete: `apps/web/src/components/overview/fleet-capacity-chart.tsx`
- Delete: `apps/web/src/components/overview/cluster-tile.tsx`
- Delete: `apps/web/src/components/overview/cluster-tile.test.tsx`
- Modify: `apps/web/src/lib/use-chart-colors.ts`

### Steps

- [ ] **Step 1: Verify nothing else imports the doomed components**

```bash
grep -rn "from '@/components/overview/fleet-capacity-chart'\|from '@/components/overview/cluster-tile'\|clusterPalette" apps/web/src --include="*.ts" --include="*.tsx"
```

Expected: only matches in `use-chart-colors.ts` (token definitions). If any other file still imports `FleetCapacityChart` or `ClusterTile`, stop and update that file too before proceeding.

- [ ] **Step 2: Delete the files**

```bash
rm apps/web/src/components/overview/fleet-capacity-chart.tsx
rm apps/web/src/components/overview/cluster-tile.tsx
rm apps/web/src/components/overview/cluster-tile.test.tsx
```

- [ ] **Step 3: Remove `clusterPalette` from the chart-colors token file**

Edit `apps/web/src/lib/use-chart-colors.ts`:

In the `ChartColors` interface, delete the line:

```ts
  clusterPalette: string[];
```

In the `LIGHT` object literal, delete the line:

```ts
  clusterPalette: ['#171717', '#404040', '#525252', '#737373', '#a3a3a3'],
```

In the `DARK` object literal, delete the line:

```ts
  clusterPalette: ['#e5e5e5', '#a3a3a3', '#737373', '#525252', '#404040'],
```

The comment block above `LIGHT` mentions "grayscale palette for non-focused series in multi-cluster charts" — update it to:

```ts
// Honey is the focused/consumption color.
```

- [ ] **Step 4: Typecheck + lint**

```bash
pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint
```

Expected: no errors, no warnings.

- [ ] **Step 5: Run the full web test suite**

```bash
pnpm --filter @lcm/web test --run
```

Expected: all tests pass. Test count should drop by however many tests were in `cluster-tile.test.tsx` (1 at time of writing).

- [ ] **Step 6: Commit**

```bash
git add -u apps/web/src/components/overview/ apps/web/src/lib/use-chart-colors.ts
git commit -m "$(cat <<'EOF'
refactor(web): Remove stacked fleet chart, ClusterTile, and grayscale palette

FleetClusterGrid + FleetUtilizationHeatmap (introduced in the prior
commits) fully cover the Overview's per-cluster story, so the old
stacked-area FleetCapacityChart, the parallel ClusterTile strip, and
the monochromatic clusterPalette tokens that only the old chart
consumed are all removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7 — Manual verification on production container

**Files:** none — verification only.

### Steps

- [ ] **Step 1: Rebuild the web container**

```bash
docker compose build web && docker compose up -d web
```

- [ ] **Step 2: Wait for the container to be ready**

```bash
until curl -s -o /dev/null -w "%{http_code}" http://localhost:8082 2>/dev/null | grep -q "^200$"; do sleep 1; done && echo "web ready"
```

- [ ] **Step 3: Manually verify the Overview at `http://localhost:8082/`**

Open the page in a browser (or via Playwright if available) and confirm:

- The page shows: KPI strip → **FleetClusterGrid** (4 tiles for the seeded clusters) → **FleetUtilizationHeatmap** (4 rows × N months).
- Tile order: **CL-Prod-P2 first** (it's already over its 48% crit threshold), then the rest in worst-runway order.
- Each tile shows the cluster's own threshold percentages in the RunwayPill (e.g. "Over 48%", "4 mo to 45%", "24+ mo").
- Each tile's warn/crit bands sit at the cluster's own warn/crit, not the system defaults.
- Clicking a tile navigates to `/clusters/<id>`.
- Heatmap row order: CL-Prod-P2 first (highest current utilization), then descending.
- Heatmap cells are visibly colored ok (success), warn (yellow), or crit (red); the CL-Prod-P2 row should be predominantly warm-colored.
- Hovering a cell shows a tooltip like `September 2026 — 48.2% (crit)`.
- The previous stacked area chart is gone.
- The previous per-cluster `ClusterTile` strip below the chart area is gone.
- Resize the viewport to ~600px wide and confirm the grid collapses to a single column and the heatmap retains its threshold cells (just thinner spacing).

If anything is off, stop and report — do not attempt a fix without going back through the spec/plan.

- [ ] **Step 4: No commit**

This task only verifies; previous commits are already in place.

---

## Spec coverage check

| Spec section                                | Covered by    |
| ------------------------------------------- | ------------- |
| 1. File layout — delete                     | Task 6        |
| 1. File layout — add                        | Tasks 2, 3, 4 |
| 1. File layout — modify routes/index.tsx    | Task 5        |
| 2. Shared `ClusterForecastEntry`            | Task 1        |
| 3. `FleetClusterGrid` — props & sort        | Task 3        |
| 4. `FleetClusterTileChart` — layout & body  | Task 2        |
| 4. `FleetClusterTileChart` — empty state    | Task 2 (test) |
| 5. `FleetUtilizationHeatmap` — props        | Task 4        |
| 5. `FleetUtilizationHeatmap` — sort         | Task 4 (test) |
| 5. `FleetUtilizationHeatmap` — cell status  | Task 4 (test) |
| 5. `FleetUtilizationHeatmap` — sparse cells | Task 4 (test) |
| 5. `FleetUtilizationHeatmap` — a11y         | Task 4 (test) |
| 6. Loading & error states                   | Tasks 3, 4, 5 |
| 7. Tests — tile / grid / heatmap            | Tasks 2, 3, 4 |
| 8. Visual / a11y manual check               | Task 7        |
