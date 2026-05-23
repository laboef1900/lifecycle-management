# Forecast legibility — design spec

**Date:** 2026-05-23
**Status:** Approved, ready for implementation plan
**Scope:** UI/UX improvements to make capacity headroom and runway-to-breach the
primary visual story across Overview, Clusters list, and Cluster detail.

## Why

The seeded fleet sits at 38–48 % utilization, well below the 70 % warn and 90 %
crit thresholds the API already encodes. The current UI renders this state as:

- Flat consumption lines with the capacity ceiling drifting off the auto-scaled
  Y-axis (the ceiling is invisible on Overview, and stuck near the top of the
  cluster-detail forecast).
- Uniformly green utilization pills on every cluster card and table row, with no
  visual cue that risk bands exist until something breaches.
- Per-cluster "12-month trend" sparklines that show two near-parallel lines and
  a dashed ceiling, communicating nothing about _how much room is left_ or
  _when_ the cluster would breach the policy threshold.

Capacity headroom and runway are the two questions this product exists to
answer; both are currently buried.

## What changes

### New visual primitives

**`<UtilizationGauge value height />`** — circular ring used as the canonical
"how full" element.

- Arc fills 0–360° proportional to `value` (0..1).
- Fill color follows existing policy bands via CSS-var tokens
  (`--utilization-ok`, `--utilization-warn`, `--utilization-crit`), so dark mode
  works without extra work.
- Unfilled segment is faintly tinted with the **next** band's color — a 48 %
  gauge subtly previews where amber begins, communicating the threshold without
  text labels.
- Center label: `{pct}%` in `font-mono tabular-nums`.
- Sizes: `lg` (96 px, cluster cards), `md` (56 px, cluster-table + detail KPI),
  `sm` (28 px, inline).
- Empty state: `value` undefined → neutral outline ring, center reads "—".
- Accessible name: `"{pct}%, status: ok|warning|critical"`.

**`<RunwayPill months />`** — pill showing months until the first 70 %
breach in the forecast horizon.

- `months < 3` → red ("2 mo to 70 %").
- `months < 12` → amber.
- `months >= 12` → success.
- Already breached (`utilization >= 0.7` today) → amber pill reading
  "Over 70 %"; if `>= 0.9`, red pill reading "Over 90 %".
- No breach in horizon → "24+ mo" with tooltip
  "no projected breach in forecast window".
- Undefined / no forecast → "—".

**Headroom band (chart treatment, not a component)** — when a chart shows both
consumption and ceiling:

- Force Y-domain to `[0, ceiling * 1.05]`.
- Render a faint Recharts `Area` filling the gap between top-of-consumption and
  ceiling, low opacity, with a dashed top stroke.
- Add labeled `ReferenceLine`s at `0.7 * ceiling` ("Warn 42,650 GB") and
  `0.9 * ceiling` ("Crit 54,835 GB"), right-aligned.
- Capacity = 0 or missing → fall back to auto-domain and skip headroom band.

### Per-page changes

**Overview (`/`)**

- Fleet stack chart: Y-domain forced to ceiling; headroom band shaded faintly
  between top-of-stack and ceiling; 70 % / 90 % reference lines labeled at the
  right edge.
- KPI strip: the "Worst cluster" tile is replaced by a **Runway tile** —
  primary value `"18 mo to 70 %"`, subtitle `"fleet headroom: 32,332 GB"`,
  body line `"limited by CL-Prod-P2"` so the worst-cluster information is
  preserved.
- Cluster card grid: each card becomes
  `[ lg gauge | name + used/cap on right | runway pill below ]`. The two-line
  sparkline is removed entirely. Card height fixed for uniform grid.

**Clusters (`/clusters`)**

- Fleet KPI banner above the table — 3-up: Used / Headroom / Runway (same
  numbers as Overview).
- Table changes:
  - Drop the "12-month trend" sparkline column.
  - Add a "Runway" column (sortable, renders `<RunwayPill>`).
  - Drop the "Actions: Open" column; the whole row becomes the link
    (`cursor-pointer`, focus ring on `<tr>`).
- Utilization column keeps the existing badge — no change.

**Cluster detail (`/clusters/:id`)**

- New KPI strip below the title — 3-up: `md` gauge · Headroom (GB) · Runway
  pill.
- Capacity forecast chart gets the same Y-domain + headroom band + labeled
  reference lines.
- Monthly-utilization bar chart: existing colored bars are correct; the 70 % /
  90 % reference lines get right-edge labels.
- The standalone "Current utilization" pill in the top right is removed (its
  value lives in the gauge now).

## Out of scope

These were identified in the audit but deferred to keep the change focused:

- Sidebar / responsive layout at < 1024 px (separate spec).
- Theme toggle becoming a dropdown menu.
- `/clusters/new` and `/settings` empty-state polish.
- Header "API: ok" pill weight, eyebrow text on Overview.
- Sort-arrow consistency in the Clusters table.

## Data

No API or schema changes. All values derive from existing `ForecastResponse`:

- **Headroom (GB)** = `metric.currentCapacity - metric.currentConsumption`.
- **Runway (months to 70 %)** = walk `forecast.months[]`, return the index of
  the first month where `utilization >= 0.7`. Pure function, returns
  `{ months: number | null, alreadyBreached: 'warn' | 'crit' | false }`.
- **Fleet runway** = aggregate consumption + capacity across clusters per
  month using the existing `aggregateFleet` helper, then apply the same
  walk.

New module `apps/web/src/lib/forecast-summary.ts` houses both helpers so they
can be unit-tested in isolation and reused.

## Edge cases

| Case                           | Gauge         | Runway pill       | Chart                                     |
| ------------------------------ | ------------- | ----------------- | ----------------------------------------- |
| No forecast / baseline         | "—"           | "—"               | unchanged                                 |
| Already breached warn (≥ 70 %) | amber, real % | "Over 70 %" amber | reference line drawn under the data       |
| Already breached crit (≥ 90 %) | red, real %   | "Over 90 %" red   | both reference lines drawn under the data |
| No breach in horizon           | normal        | "{N}+ mo"         | full headroom band visible                |
| Capacity = 0 / missing         | "—"           | "—"               | auto-domain, no headroom band             |
| Sparse forecast (< 2 months)   | normal        | "—"               | chart renders what it has                 |

## Files

**New**

- `apps/web/src/components/ui/utilization-gauge.tsx`
- `apps/web/src/components/ui/runway-pill.tsx`
- `apps/web/src/lib/forecast-summary.ts`
- Test files for each of the above.

**Modified**

- `apps/web/src/components/overview/cluster-tile.tsx` — drop sparkline import,
  add gauge + runway.
- `apps/web/src/components/overview/fleet-capacity-chart.tsx` — Y-domain,
  headroom area, labeled reference lines.
- `apps/web/src/components/clusters/cluster-table.tsx` — drop sparkline
  column, add Runway column, clickable rows, drop Actions column.
- `apps/web/src/components/clusters/utilization-panel.tsx` — label the 70 % /
  90 % reference lines at the right edge.
- `apps/web/src/routes/index.tsx` — swap Worst-cluster KPI for Runway KPI,
  wire fleet-runway computation.
- `apps/web/src/routes/clusters.$id.tsx` — add KPI strip, remove the
  standalone "Current utilization" pill.

**Removed**

- `apps/web/src/components/sparkline.tsx` — only consumers are `cluster-tile`
  and `cluster-sparkline-cell`, both being rewritten or removed.
- `apps/web/src/components/clusters/cluster-sparkline-cell.tsx` — column
  dropped from the table.

## Testing

Per the project's TDD discipline:

**Unit**

- `forecast-summary.ts` — no-breach, immediate breach (warn / crit),
  mid-horizon breach, zero capacity, empty months.
- `<UtilizationGauge>` — color band by value, "—" when undefined, accessible
  name.
- `<RunwayPill>` — color + copy by months remaining, already-breached
  branches, "—" when undefined.
- `<ClusterTile>` — renders gauge + runway, links to detail.

**E2E (extends existing Playwright golden path)**

- On `/`: assert gauge value and runway pill present on each cluster card.
- On `/clusters/:id`: assert KPI strip shows three tiles (gauge / headroom /
  runway).
- On `/clusters`: assert Runway column is sortable; row click navigates to
  detail.

## Definition of done

- All unit + E2E tests green.
- `pnpm lint` and `pnpm typecheck` clean.
- Manual check via Playwright at 1440 × 900 light + dark:
  - Overview ceiling line visible inside the chart.
  - Headroom band visibly shaded.
  - 70 % / 90 % reference lines labeled.
  - Cluster cards show a gauge + runway, no sparkline.
  - Cluster-detail KPI strip shows gauge, headroom, runway.
- No regressions in the existing `pnpm --filter @lcm/web test:e2e` golden path
  beyond the assertions updated for this spec.
