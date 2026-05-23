# Bento Overview — Design Spec

_Date: 2026-05-23_
_Source vision: [`docs/vision.md`](../../vision.md)_
_Builds on: [`2026-05-23-ui-refresh-enterprise-dark-mode-design.md`](2026-05-23-ui-refresh-enterprise-dark-mode-design.md), [`2026-05-23-apple-polish-design.md`](2026-05-23-apple-polish-design.md)_

## Goal

Make the default landing page a glanceable "bento" overview of the fleet — KPI tiles, a stacked fleet-capacity chart, and one clickable tile per cluster — while keeping the existing dense cluster table available at `/clusters`. Reuses the existing token system, primitives, and theme.

## Clarifications (locked in 2026-05-23)

| Topic              | Decision                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Landing route      | `/` becomes the bento Overview; cluster table moves to `/clusters`                                                 |
| Sidebar order      | Overview (1st), Clusters (2nd), Settings (3rd)                                                                     |
| Hero chart         | Yes — stacked area, per-cluster bands, summed capacity ceiling. Client-side aggregation from per-cluster forecasts |
| Cluster tile click | Whole tile is a `<Link>` to `/clusters/$id`                                                                        |
| Keyboard shortcuts | `g o` → Overview, `g c` → Clusters, `g s` → Settings. `g d` removed.                                               |
| API changes        | None — aggregation happens client-side via `useQueries` over existing `api.clusters.forecast`                      |

## Non-goals

- New API endpoints or aggregation work on the server.
- Drag-to-rearrange / configurable tile sizes.
- A time-range picker on the fleet chart (it uses a fixed 24-month window).
- "Recent events" / "Recent activity" tile.
- Headroom-remaining or "predicted exhaustion date" tile.
- Restructuring the cluster table's internal logic — it just moves files.

---

## Architecture

### Routing restructure

| Path            | File (new vs current)                              | Contents                                                                          |
| --------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `/`             | `apps/web/src/routes/index.tsx` (full rewrite)     | New bento Overview page (this spec)                                               |
| `/clusters`     | `apps/web/src/routes/clusters.index.tsx` (new)     | The existing dashboard table content (moved verbatim from old `routes/index.tsx`) |
| `/clusters/$id` | `apps/web/src/routes/clusters.$id.tsx` (unchanged) |                                                                                   |
| `/clusters/new` | `apps/web/src/routes/clusters.new.tsx` (unchanged) |                                                                                   |
| `/settings`     | `apps/web/src/routes/settings.tsx` (unchanged)     |                                                                                   |

TanStack Router's Vite plugin regenerates `routeTree.gen.ts` automatically when a route file is added or renamed. No manual codegen step in the plan.

### New components

**`apps/web/src/components/overview/kpi-tile.tsx`** — small Card variant for single-stat display:

```tsx
interface KpiTileProps {
  label: string; // Eyebrow text, e.g., "Fleet utilization"
  value: string; // Big number, e.g., "44.6%"
  caption?: string; // Optional small line under the value
  status?: 'ok' | 'warn' | 'crit'; // Optional status dot color
  className?: string;
}
```

Renders as a `<Card>` with `p-5`. Eyebrow uses the same uppercase-tracking treatment from the polish iteration (`text-[11px] font-semibold uppercase tracking-wider text-muted-foreground`). Value is `text-3xl font-semibold tracking-tight`. Optional status dot pairs with `--success` / `--warning` / `--destructive` tokens.

**`apps/web/src/components/overview/cluster-tile.tsx`** — a clickable cluster card:

```tsx
interface ClusterTileProps {
  cluster: ClusterResponse; // From @lcm/shared
  className?: string;
}
```

Renders as a `<Card>` wrapped in TanStack Router's `<Link to="/clusters/$id" params={{ id: cluster.id }}>`. Layout:

- Top row: cluster name (`text-base font-semibold`) + `UtilizationBadge` right-aligned.
- Middle row: "consumption / capacity GB" in font-mono tabular-nums with muted-foreground.
- Bottom: `Sparkline` of the 12-month consumption trend, taking the full tile width.
- Hover: `hover:shadow-md transition-shadow duration-150` for a subtle lift.
- Focus-visible: same ring treatment as Button.

If the cluster has no metric data, the badge and sparkline are omitted and a "No baseline" muted line takes their place.

**`apps/web/src/components/overview/fleet-capacity-chart.tsx`** — Recharts stacked-area chart:

```tsx
interface FleetCapacityChartProps {
  forecasts: Array<{ clusterName: string; clusterId: string; months: ForecastPoint[] }>;
}
```

`AreaChart` with one `<Area stackId="fleet" dataKey={clusterId}>` per cluster, plus one `<Line>` for the summed capacity ceiling. Data is reshaped client-side from per-cluster forecasts into rows of `{ month, [clusterId1]: consumption, [clusterId2]: consumption, ..., capacityTotal }`. Tooltip lists each cluster's contribution + the fleet total. Uses `useChartColors().clusterPalette` (new field — see below) so each cluster gets a stable distinct color across light/dark.

### `useChartColors` extension

Add `clusterPalette: string[]` to `ChartColors`. Six distinct OKLCH hues — enough for foreseeable cluster counts (we have 4 today, plan for ~10):

| Index | Light                      | Dark                       |
| ----- | -------------------------- | -------------------------- |
| 0     | oklch(55% 0.18 262) indigo | oklch(72% 0.16 262) indigo |
| 1     | oklch(58% 0.18 195) teal   | oklch(74% 0.14 195) teal   |
| 2     | oklch(60% 0.17 145) green  | oklch(75% 0.13 145) green  |
| 3     | oklch(62% 0.19 60) amber   | oklch(78% 0.16 60) amber   |
| 4     | oklch(60% 0.22 25) red     | oklch(75% 0.18 25) red     |
| 5     | oklch(58% 0.20 305) violet | oklch(74% 0.16 305) violet |

Cluster-to-color mapping is by stable index — sort clusters by ID, take `clusterPalette[idx % 6]`. Predictable across sessions; each cluster keeps the same color.

### Aggregation helper

New module `apps/web/src/lib/aggregate-fleet.ts`:

```ts
export interface FleetSummary {
  totalConsumption: number; // Most-recent month total
  totalCapacity: number; // Most-recent month total
  utilization: number; // totalConsumption / totalCapacity, 0..1
  clusterCount: number;
  worstCluster: { id: string; name: string; utilization: number } | null;
  perClusterSeries: Array<{
    clusterId: string;
    clusterName: string;
    months: ForecastPoint[];
  }>;
  fleetMonths: Array<{
    month: string;
    capacityTotal: number; // Summed across clusters
    [clusterId: string]: number | string;
  }>;
}

export function aggregateFleet(
  clusters: ClusterResponse[],
  forecasts: Array<{ clusterId: string; data: ForecastResponse | undefined }>,
): FleetSummary;
```

Pure function. Sums per-month values across clusters, picks the worst-utilization cluster, returns shapes ready for tiles and the chart. Unit-tested.

### Layout (`routes/index.tsx`)

```tsx
<div className="space-y-6">
  <header>
    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      Overview
    </p>
    <h1 className="text-[1.625rem] font-semibold tracking-tight">Fleet</h1>
  </header>

  <div className="grid grid-cols-12 gap-4">
    <KpiTile
      className="col-span-12 sm:col-span-4"
      label="Fleet utilization"
      value="44.6%"
      caption="memory used"
      status="ok"
    />
    <KpiTile
      className="col-span-12 sm:col-span-4"
      label="Clusters tracked"
      value="4"
      caption="all responsive"
      status="ok"
    />
    <KpiTile
      className="col-span-12 sm:col-span-4"
      label="Worst cluster"
      value="CL-Prod-P2"
      caption="46.8% utilization"
      status="ok"
    />

    <Card className="col-span-12 p-4">
      <FleetCapacityChart forecasts={summary.perClusterSeries} />
    </Card>

    {summary.perClusterSeries.map((c) => (
      <ClusterTile key={c.clusterId} cluster={c.cluster} className="col-span-12 md:col-span-6" />
    ))}
  </div>
</div>
```

Real values come from `aggregateFleet`. Responsive: full-width tiles on mobile, 2-col grid at `md`, 3-col KPI / 1-col chart / 2-col cluster tiles at `sm+`.

### Sidebar update

`apps/web/src/components/layout/sidebar.tsx` `navItems` array:

```ts
const navItems = [
  { to: '/', label: 'Overview', icon: LayoutPanelLeft, exact: true },
  { to: '/clusters', label: 'Clusters', icon: Database, exact: false },
  { to: '/settings', label: 'Settings', icon: Settings, exact: false },
] as const;
```

The `LayoutPanelLeft` and `Database` icons come from `lucide-react` (already in deps).

### Breadcrumbs update

`apps/web/src/components/layout/breadcrumbs.tsx` `crumbs` derivation:

- `/` → `[{ label: 'Overview' }]`
- `/clusters` → `[{ label: 'Clusters' }]`
- `/clusters/new` → `[{ label: 'Clusters', to: '/clusters' }, { label: 'New cluster' }]`
- `/clusters/$id` → `[{ label: 'Clusters', to: '/clusters' }, clusterCrumb]`
- `/settings` → `[{ label: 'Settings' }]`

### Command palette update

`apps/web/src/components/command/command-palette.tsx` Navigation group:

```tsx
<PaletteItem icon={LayoutPanelLeft} label="Go to overview" hint="g o"
  onSelect={() => runAndClose(() => navigate({ to: '/' }))} />
<PaletteItem icon={Database} label="Go to clusters" hint="g c"
  onSelect={() => runAndClose(() => navigate({ to: '/clusters' }))} />
<PaletteItem icon={Settings} label="Go to settings" hint="g s"
  onSelect={() => runAndClose(() => navigate({ to: '/settings' }))} />
```

Replace the existing two items ("Go to dashboard" and "Go to settings"). The `LayoutDashboard` import is replaced with `LayoutPanelLeft` and `Database`.

### Keyboard shortcuts update

`apps/web/src/components/command/keyboard-shortcuts.tsx` — replace the `g d`/`g s` branches:

```ts
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

### Shortcuts dialog update

`apps/web/src/components/command/shortcuts-dialog.tsx` `ROWS`:

```ts
const ROWS: Row[] = [
  { keys: ['⌘', 'K'], label: 'Open command palette' },
  { keys: ['?'], label: 'Show this shortcuts list' },
  { keys: ['Esc'], label: 'Close any modal' },
  { keys: ['g', 'o'], label: 'Go to overview' },
  { keys: ['g', 'c'], label: 'Go to clusters' },
  { keys: ['g', 's'], label: 'Go to settings' },
];
```

### Test updates

- **`apps/web/src/__tests__/keyboard-shortcuts.test.tsx`** — current tests assert `g s` → `/settings` and `g d` → `/`. Update to `g c` → `/clusters` and `g s` → `/settings`. Test router gets a `/clusters` route added to the memory history.
- **`apps/web/src/__tests__/command-palette.test.tsx`** — current selection test types `CL-One` and presses Enter, then asserts `navigate` was called with `{ to: '/clusters/$id', params: { id: 'cluster-xyz' } }`. Unchanged behavior; should still pass.
- **`apps/web/src/components/clusters/cluster-table.test.tsx`** — tests render the table in isolation; not affected by the file move.
- **`apps/web/src/components/clusters/forecast-chart.test.tsx`** — unaffected.
- **`apps/web/src/components/clusters/create-cluster-dialog.test.tsx`** — unaffected.
- **`apps/web/src/__tests__/use-theme.test.tsx`** — unaffected.
- **New test:** `apps/web/src/__tests__/aggregate-fleet.test.ts` — unit tests for `aggregateFleet()` covering: empty clusters, single cluster, multiple clusters, missing forecast for one cluster, identifying the worst-utilization cluster.
- **Playwright e2e** — the existing `golden-path.spec.ts` starts at `/` and clicks "+ Add cluster". Under the new structure, "+ Add cluster" is on `/clusters` (the table page), not `/`. Update the spec to navigate to `/clusters` first (one extra line at the top). The theme-toggle assertions are independent of route and stay the same.

---

## File map

**New files:**

- `apps/web/src/components/overview/kpi-tile.tsx`
- `apps/web/src/components/overview/cluster-tile.tsx`
- `apps/web/src/components/overview/fleet-capacity-chart.tsx`
- `apps/web/src/lib/aggregate-fleet.ts`
- `apps/web/src/__tests__/aggregate-fleet.test.ts`
- `apps/web/src/routes/clusters.index.tsx`

**Modified:**

- `apps/web/src/routes/index.tsx` — fully rewritten (was the table, now the bento)
- `apps/web/src/components/layout/sidebar.tsx` — new nav items + icons + order
- `apps/web/src/components/layout/breadcrumbs.tsx` — updated path patterns
- `apps/web/src/components/command/command-palette.tsx` — Navigation group items
- `apps/web/src/components/command/keyboard-shortcuts.tsx` — `g o`/`g c`/`g s`
- `apps/web/src/components/command/shortcuts-dialog.tsx` — `ROWS` updated
- `apps/web/src/lib/use-chart-colors.ts` — add `clusterPalette: string[]` to `ChartColors`; fill both `LIGHT` and `DARK` with 6 OKLCH values
- `apps/web/src/__tests__/keyboard-shortcuts.test.tsx` — assert against `g c` → `/clusters`
- `apps/web/playwright/golden-path.spec.ts` — start at `/clusters` (one line: `await page.goto('/clusters');` replacing `await page.goto('/');`)

**Untouched:** API, schema, `packages/shared`, Docker, CI, ThemeProvider, useTheme, Toaster, Tooltip, Badge (still used inside ClusterTile), Button, Card, Kbd, all chart files (Sparkline + forecast-chart + utilization-panel — they keep working), the `routes/clusters.$id.tsx` and `routes/clusters.new.tsx` route files themselves (their content is the same).

---

## Testing

Verification commands:

```bash
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
pnpm --filter @lcm/web build
pnpm --filter @lcm/web test:e2e   # if API is up
```

All must pass.

**Test counts (post-change):**

- Existing unit tests: 18 (use-theme 5, command-palette 2, keyboard-shortcuts 2, forecast-chart 3, cluster-table 4, create-cluster-dialog 2)
- New: `aggregate-fleet.test.ts` — ~5 tests
- Total: ~23 unit tests + 1 Playwright

The two existing keyboard-shortcuts tests are modified (not added); their count stays at 2 but the assertions change.

**Manual visual check:**

1. Visit `/` — see the bento overview with KPI tiles + chart + 4 cluster tiles.
2. Click a cluster tile → lands on `/clusters/$id`.
3. Press `g c` → navigates to `/clusters`, the existing table view.
4. Press `g o` → navigates back to `/`.
5. Press `⌘K` → command palette lists "Go to overview", "Go to clusters", "Go to settings".
6. Press `?` → shortcuts dialog shows the three `g _` shortcuts.
7. Toggle theme — KPI tiles, chart colors, sparkline colors, and cluster-tile shadows all repaint correctly.
8. Resize window — bento collapses 12→2→1 col gracefully.

---

## Risks & mitigations

| Risk                                                                                               | Mitigation                                                                                                                          |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `useQueries` for forecasts fans out N requests; could be slow with many clusters                   | We have 4. If we ever hit ~30+, add a server-side aggregate endpoint. YAGNI for v1.                                                 |
| Stacked area chart with same `dataKey` per cluster doesn't work — Recharts needs per-key           | Reshape data so each row has keys like `{ month, [clusterId]: consumption, … }`. Documented in fleet-chart impl.                    |
| Cluster colors clash with the existing `consumption`/`capacity` Recharts strokes                   | Cluster palette is only used in the new fleet chart; existing forecast-chart keeps its `consumption`/`capacity` tokens. No overlap. |
| `g d` muscle memory breaks for users                                                               | We're 5 internal users — verbal heads-up. Shortcuts dialog now lists the new keys.                                                  |
| Moving `routes/index.tsx` table content to `routes/clusters.index.tsx` triggers route regeneration | TanStack Vite plugin handles this on dev/build. Verified by running `pnpm dev` after the change.                                    |
| Some external link still points to `/` expecting the table                                         | None in scope — no external links to the app. Sidebar Clusters item is the entry point.                                             |

---

## Acceptance criteria

1. `/` renders the bento Overview: page header "Overview" + h1 "Fleet"; 3 KPI tiles; one full-width fleet capacity chart; 2x2 grid of cluster tiles.
2. Each cluster tile is a clickable Link; clicking navigates to `/clusters/$id`.
3. `/clusters` renders the existing cluster table (same sortable columns, same actions).
4. Sidebar shows: Overview (with `LayoutPanelLeft` icon) → Clusters (with `Database` icon) → Settings, in that order. Active state highlights correctly per route.
5. Breadcrumbs reflect: Overview, Clusters, Clusters › {cluster name}, Clusters › New cluster, Settings.
6. `g o` navigates to `/`; `g c` navigates to `/clusters`; `g s` navigates to `/settings`. `g d` does nothing.
7. Command palette Navigation group lists the three items with the new hints.
8. Shortcuts dialog lists 6 rows including `g o`, `g c`, `g s`.
9. Fleet capacity chart uses 4 distinct stacked-area colors (one per cluster, stable across light/dark).
10. `aggregateFleet()` correctly identifies the worst-utilization cluster, handles empty/single/missing-forecast cases.
11. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all pass on the web workspace. Playwright golden path passes after the single `page.goto` update.
12. No changes outside `apps/web/**` plus the spec/plan docs.
