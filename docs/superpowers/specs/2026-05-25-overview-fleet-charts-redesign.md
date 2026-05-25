# Overview fleet charts redesign — design spec

**Date:** 2026-05-25
**Status:** Approved, ready for implementation plan
**Scope:** Replace the stacked-area `FleetCapacityChart` on the Overview route (`/`) with two new views: a small-multiples grid of per-cluster utilization mini-charts and a cluster × month utilization heatmap. The KPI tiles above the chart area (Fleet utilization, Clusters tracked, Fleet runway) are unchanged.

## Why

The current Fleet capacity chart has three concrete problems:

1. **All clusters look identical.** `lib/use-chart-colors.ts` defines `clusterPalette` as a monochromatic grayscale ramp (`#171717 → #404040 → #525252 → #737373 → #a3a3a3`), so the four stacked areas are visually indistinguishable.
2. **Stacked semantics hide per-cluster headroom.** A cluster pinned at 95% of its own capacity is invisible when the fleet total still has slack; the stack adds consumption across clusters and caps it with a fleet-total capacity ceiling, which is not what an operator needs to decide where to invest.
3. **A single GB Y-axis obscures relative pressure.** A 4,000 GB cluster at 95% and a 40,000 GB cluster at 50% are equally important signals but render at vastly different visual scales.

The fix is two separate views with clear, complementary purposes:

- **Small multiples** — one mini-chart per cluster on a 0–100% Y-axis, sorted worst-runway-first, so each cluster's pressure is visible regardless of fleet size. Best for spotting _which_ cluster needs attention.
- **Heatmap** — cluster × month threshold-stepped color, sorted worst-current-utilization-first. Best for spotting _when_ fleet-wide pressure builds and which clusters share the timing.

The current chart's "total GB consumed" story is already told by the KPI tiles above (`Used 29,496 GB of 65,024 GB capacity` + `Headroom` + `Fleet runway`), so removing the stacked chart loses no information.

## Design principles

1. **One color language across the page.** Threshold status (ok / warn / crit) drives color in both new views, mirroring `UtilizationBadge` and the cluster detail forecast chart. No per-cluster categorical colors.
2. **Cluster-specific thresholds, always.** Each cluster's effective warn/crit (already plumbed end-to-end after the runway-KPI fix) drives its mini-chart bands, its heatmap cell color, and its runway pill. No system defaults at this layer.
3. **Replace, don't tab.** Tabs would preserve the misleading stacked semantics as an option and double maintenance. The KPIs above the chart area carry the fleet-total story.
4. **One precompute, two consumers.** The route builds one `ClusterForecastEntry[]` and passes it to both views. No duplicated `runwayToWarn` calls or data shaping inside the chart components.

## What changes

### 1. File layout

**Delete**

- `apps/web/src/components/overview/fleet-capacity-chart.tsx`
- The stacked-chart-specific bits of any related test (none exist for `fleet-capacity-chart` itself currently; if added during implementation they go with the file).
- The `clusterPalette: string[]` entries in both light- and dark-mode color tokens in `apps/web/src/lib/use-chart-colors.ts`, and the `clusterPalette` field on the colors interface. (Only consumer is the deleted chart.)

**Add** (all under `apps/web/src/components/overview/`)

- `fleet-cluster-grid.tsx` — small-multiples grid; sorts entries worst-runway-first; renders one tile per cluster.
- `fleet-cluster-tile-chart.tsx` — single per-cluster mini utilization chart (Card → Link → header + LineChart).
- `fleet-utilization-heatmap.tsx` — cluster × month threshold-stepped heatmap (semantic `<table>`).
- `fleet-cluster-grid.test.tsx`, `fleet-cluster-tile-chart.test.tsx`, `fleet-utilization-heatmap.test.tsx`.

**Modify**

- `apps/web/src/routes/index.tsx` — replace the `<Card className="col-span-12 p-4"><FleetCapacityChart …/></Card>` block with two new `col-span-12` blocks: `<FleetClusterGrid …/>` then `<FleetUtilizationHeatmap …/>`. Build `clusterEntries: ClusterForecastEntry[]` once in a `useMemo` and pass to both. Drop the per-cluster `ClusterTile` strip below (the small-multiples grid replaces it) — verify no other surface depends on `ClusterTile`; if not, delete that component too.

### 2. Shared data shape

Built once in `routes/index.tsx`, passed to both new views:

```ts
interface ClusterForecastEntry {
  cluster: ClusterResponse;
  months: ForecastMonthPoint[];
  thresholds: { warn: number; crit: number };
  summary: RunwaySummary; // from runwayToWarn(months, thresholds)
}
```

`thresholds` is sourced from `forecastQueries[i].data.effectiveThresholds` (already returned by the API after the runway-KPI fix). `summary` is computed once here rather than inside each tile, so sort logic and pill rendering see identical values.

### 3. `FleetClusterGrid`

**Props**

```ts
interface FleetClusterGridProps {
  entries: ClusterForecastEntry[];
  isLoading?: boolean;
}
```

**Behavior**

- Sorts `entries` by a numeric `sortKey`:
  - `summary.alreadyBreached === 'crit'` → `-2`
  - `summary.alreadyBreached === 'warn'` → `-1`
  - else `summary.months !== null` → `summary.months` (smaller = sooner = worse)
  - else (no projected breach) → `+Infinity`
- Tie-breaker: `cluster.name.localeCompare(b.cluster.name)`.
- Renders a Tailwind CSS grid: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3`.
- When `isLoading` is `true`, renders 4 placeholder skeleton tiles (`Card` with `animate-pulse`) at the same fixed height. (4 is a placeholder count, not tied to the real cluster count which isn't known yet.)

### 4. `FleetClusterTileChart`

**Props**

```ts
interface FleetClusterTileChartProps {
  entry: ClusterForecastEntry;
}
```

**Layout (~180px tall, fixed)**

- Outer `<Card>` wraps a TanStack `<Link to="/clusters/$id" params={{ id: cluster.id }}>` so the whole tile is clickable and keyboard-navigable.
- Header row (compact): cluster name on the left, `<RunwayPill summary={entry.summary} thresholds={entry.thresholds} horizonMonths={months.length} />` on the right.
- Body: ~110px tall `ResponsiveContainer` → Recharts `LineChart`:
  - `data` = `entry.months.map(m => ({ month: m.month, util: m.capacity > 0 ? m.consumption / m.capacity : 0 }))`.
  - Y axis hidden, domain `[0, 1]`.
  - X axis hidden ticks, just the line.
  - Two `<ReferenceArea>`s: `y1=entry.thresholds.warn, y2=entry.thresholds.crit` filled `colors.utilizationWarn` at ~0.10 opacity; `y1=entry.thresholds.crit, y2=1` filled `colors.utilizationCrit` at ~0.12 opacity.
  - One `<Line>` with `stroke={colors.consumption}`, `strokeWidth={2}`, `dot={false}`, `isAnimationActive={false}`.
  - Custom `<Tooltip>` showing `"Sep 2026 — 48.2%"` on hover (no per-cluster legend chip; the tile itself is the legend).
- Empty (`entry.months.length === 0`): renders the header but replaces the body with a centered "No forecast" `text-fg-muted` line.

### 5. `FleetUtilizationHeatmap`

**Props**

```ts
interface FleetUtilizationHeatmapProps {
  entries: ClusterForecastEntry[];
  isLoading?: boolean;
}
```

**Behavior**

- Wrapped in `<Card>`. Renders a semantic `<table>` with `<thead>` of month columns + `<tbody>` of cluster rows.
- Rows sorted by `entry.cluster.metrics[0].utilization` desc. Tie-breaker: cluster name asc.
- Month columns derived from the union of all entries' `months[].month`, sorted ascending. Sparse-cluster handling: if a cluster has no point for a month, render a muted gray cell ("no data").
- Each data cell:
  - Computes `status = utilStatus(util, entry.thresholds)` (existing helper, returns `'ok' | 'warn' | 'crit'`).
  - Renders a square swatch (`w-3 h-3` desktop, `w-2 h-2` mobile). Background uses the same color tokens that `UtilizationBadge` already uses for its ok / warn / crit variants — read those off the existing component during implementation rather than introducing parallel class names.
  - `title="Sep 2026 — 48.2% (crit)"` for native hover tooltip.
  - `aria-label` with the same content; visible text is `sr-only`.
  - `data-status="ok|warn|crit"` for tests.
- Header row labels every 3rd month on narrow viewports (`hidden md:table-cell` on the others) to avoid horizontal scroll; desktop shows every month.
- When `isLoading` is `true`, renders 4 skeleton rows.

### 6. Empty / loading / error states

- Route already handles `isLoading` / `isError` / `clusters.length === 0` outside the chart area — unchanged.
- New components receive `isLoading` from `clustersQuery.isPending || forecastQueries.some(q => q.isPending)` so skeletons appear during forecast load even after clusters resolve.
- Individual cluster forecast errors: tile renders a small inline error label inside the body; heatmap row renders muted "no data" cells for that cluster. Neither component aborts rendering.

### 7. Tests

`fleet-cluster-tile-chart.test.tsx`

- Renders the cluster name and the RunwayPill with the cluster's thresholds (asserts the pill label uses the cluster's percentage, e.g. `"4 mo to 45%"`).
- Renders a `line-util` line (with `Line` mocked by data-testid like the existing forecast-chart test).
- Tile root is an `<a>` with `href="/clusters/<id>"`.
- Renders "No forecast" when `entry.months` is empty.

`fleet-cluster-grid.test.tsx`

- Given 4 entries with mixed `alreadyBreached: 'crit'` / `'warn'` / `months: 5` / `months: null`, asserts the rendered tile order is: crit → warn → 5 → null.
- Tie-breaker test: two entries with identical sort keys ordered alphabetically by cluster name.
- `isLoading` renders the skeleton variant (asserts `data-testid="grid-skeleton"`).

`fleet-utilization-heatmap.test.tsx`

- Three clusters across four months: cells have correct `data-status` per `utilStatus(util, thresholds)`.
- Rows sorted by current utilization desc.
- Sparse cluster: month with no data gets `data-status="empty"`.
- Each data cell has an `aria-label` matching the format `"<Month YYYY> — <pct>% (<status>)"`.

### 8. Visual / accessibility checks (manual, not in CI)

- Verify on the production stack (`:8082`) after rebuild: grid renders 4 tiles for the seeded clusters (CL-DMZ-P1, CL-Prod-P2, CL-Prod-P2-Oracle, CL-Test-P2), sorted with CL-Prod-P2 first (already over crit) and CL-DMZ-P1 second (warn band coming up).
- Heatmap rows sorted with CL-Prod-P2 first.
- Keyboard tab navigates through tiles in sort order; Enter opens the cluster detail page.
- Dark mode: warn/crit bands still readable; cell swatches visible against `bg-card`.

## Out of scope

- Tooltips with rich cluster context (host count, allocations) on tile hover — defer.
- Brush / zoom on the heatmap for windows shorter than 24 months — the existing window-selector on the cluster detail page covers per-cluster zoom; fleet-level brush is a separate feature.
- Animations / transitions on sort order changes — sort is stable across renders for the same data; on data refresh, React Query already deduplicates so tiles don't re-mount.
- Replacing the per-cluster Hosts / Applications / Events bar charts elsewhere in the app.
- A new color palette / design tokens — reuse the existing `colors.utilizationOk|Warn|Crit` and `colors.consumption` tokens.
