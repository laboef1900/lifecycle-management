# Mission Bento UI — Design Specification

**Date:** 2026-07-16 · **Risk class:** Normal (UI-only; no auth/crypto/migrations/forecast-engine changes)
**Approved design reference:** `docs/mockups/06-mission-bento.html` in the main checkout (untracked design artifact; the token tables below are the durable record).
**Decision trail:** user selected "Mission Control" direction with bento overview (2026-07-16), then: uniform tiles, 3 per row, smaller verdict headline, no action queue on the overview, plus six UX upgrades (calm state, stale-baseline warnings, scenario ghost line, host lifecycle Gantt, interactive rail, urgency sort).

## 1. Problem and outcome

The current UI is a generic 2020 admin template with two near-duplicate pages (Overview, Clusters). The redesign turns the app into a single **fleet console**: one screen that answers "what do I have to order, and when" at a glance, with cluster detail as a slide-in panel instead of a separate page. Forecast/procurement data drives every element; no new backend endpoints are required (order-by dates, scenario overlays, host lifecycle dates and thresholds all exist in the API today).

## 2. Information architecture

| Route           | Before                                   | After                                                                                                                  |
| --------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/`             | Overview (KPI tiles, tile grid, heatmap) | **Fleet console**: order-by rail, fleet verdict, cluster tile grid (3-up), add-cluster + show-archived controls        |
| `/clusters`     | Clusters list (table + grid + KPIs)      | Redirect to `/`                                                                                                        |
| `/clusters/new` | Dead placeholder                         | Deleted                                                                                                                |
| `/clusters/$id` | Detail page                              | Same URL renders the fleet console **with the detail slide-in panel open** (deep-linkable; Esc/close navigates to `/`) |
| `/settings`     | Settings page                            | Unchanged structurally; restyled by tokens                                                                             |
| `/login`        | Login                                    | Unchanged structurally; restyled by tokens                                                                             |

Chrome: the sidebar, breadcrumbs, and mobile nav drawer are removed. A single topbar carries: brand (links `/`), search/⌘K trigger, Settings link, theme toggle, user menu. Command palette: "Go to overview"/"Go to clusters" collapse into "Go to fleet" (`g o`; `g c` removed), per-cluster entries keep navigating to `/clusters/$id` (which now opens the panel). `g s` unchanged.

## 3. Design system (tokens in `apps/web/src/styles.css`)

Fonts (self-hosted @fontsource, replacing IBM Plex): **Space Grotesk** 500/600/700 → new `--font-display`; **Inter** 400/500/600/700 → `--font-sans`; **JetBrains Mono** 400/500/600/700 → `--font-mono`. All data numerals use mono with `tabular-nums`.

### Dark theme (primary; from the mockup)

| Token             | Value        |     | Token                                   | Value      |
| ----------------- | ------------ | --- | --------------------------------------- | ---------- |
| `--background`    | `#0E1220`    |     | `--accent` (amber)                      | `#FFC53D`  |
| `--card`          | `#151B2C`    |     | `--accent-foreground`                   | `#171C2C`  |
| `--card-hover`    | `#1A2136`    |     | `--steel` (new: interaction/info/focus) | `#6EA8FF`  |
| `--popover`       | `#10162A`    |     | `--success`                             | `#3DD68C`  |
| `--border`        | `#232B40`    |     | `--warning`                             | `#FFC53D`  |
| `--border-strong` | `#314063`    |     | `--destructive`                         | `#FF6B6B`  |
| `--foreground`    | `#E8ECF5`    |     | `--ring`                                | `--steel`  |
| `--fg-muted`      | `#8B93A7`    |     | `--chart-capacity`                      | `#C7D0E4`  |
| `--fg-subtle`     | `#7C86A0`    |     | `--chart-consumption`                   | `--accent` |
| `--input`         | `#10162A`    |     | `--chart-grid`                          | `#1B2236`  |
| `--sidebar`       | delete token |     | `--chart-axis`                          | `#2A3450`  |

Body backdrop: `radial-gradient(1200px 500px at 50% -220px, #141B31 0%, var(--background) 60%)`. Card/tile fill: `linear-gradient(180deg,#171E31,#131928)`, hover `#1A2136→#151B2C`. Amber meter fill `linear-gradient(90deg,#D9A32C,#FFC53D)` with soft glow.

### Light theme (new sibling — designed for this spec, same hue system)

| Token             | Value     |     | Token                 | Value     |
| ----------------- | --------- | --- | --------------------- | --------- |
| `--background`    | `#F4F6FA` |     | `--accent`            | `#8F6400` |
| `--card`          | `#FFFFFF` |     | `--accent-foreground` | `#FFFFFF` |
| `--card-hover`    | `#EDF1F8` |     | `--steel`             | `#2F6BD8` |
| `--popover`       | `#FFFFFF` |     | `--success`           | `#1E7F4F` |
| `--border`        | `#DCE2EE` |     | `--warning`           | `#95610C` |
| `--border-strong` | `#C2CCE0` |     | `--destructive`       | `#C0343C` |
| `--foreground`    | `#171C2C` |     | `--ring`              | `--steel` |
| `--fg-muted`      | `#5A6478` |     | `--chart-capacity`    | `#3A455E` |
| `--fg-subtle`     | `#76809A` |     | `--chart-consumption` | `#8F6400` |
| `--input`         | `#C9D2E4` |     | `--chart-grid`        | `#E3E8F2` |
|                   |           |     | `--chart-axis`        | `#8A94AC` |

Constraint: implementer MAY adjust light values by small steps to reach WCAG AA (≥4.5:1 body/meaning-bearing text on its surface, ≥3:1 UI graphics), but must keep the hue family and record the final values in the PR description.

Radii: `--radius: 8px`, `--radius-card: 14px`, `--radius-modal: 16px`. Focus: global two-layer ring — `outline: 2px solid var(--steel); outline-offset: 2px` plus a `box-shadow` separator in the surface color. Motion: hover transitions 120 ms; panel enters 280 ms `cubic-bezier(0,0,.38,.9)`, exits 200 ms `cubic-bezier(.4,0,1,1)`; existing `prefers-reduced-motion` kill-switch stays. Status is never color-alone (chip text/icons accompany every state).

## 4. Fleet console composition (top → bottom)

1. **Topbar** — brand, ⌘K search trigger, Settings link, theme toggle, user menu.
2. **Order-by rail** — full-width 12-month strip. NOW line at left (steel, labeled). One tick per cluster with a non-null `forecast.procurement.orderByDate` inside the window, labeled `<cluster> · <MMM D> · <urgency word>`; the earliest tick gets the shaded 90-day/lead-time zone. Tick urgency tone: crit if order-by ≤ 28 days or past (matches `deriveProcurementKpi` URGENT_DAYS), warn if ≤ 90 days, muted otherwise. Empty state (no order-bys): centered ✓ + "No order-by dates in the next 12 months". Hover/focus of a tick highlights its tile (and vice versa) via `data-cluster-id` linking.
3. **Fleet verdict panel** — display-font headline computed from fleet state: urgent form "Fleet runway is **N mo** — **<cluster>** needs an order by **<MMM D>**." (from `fleetRunwayToWarn` + `earliestOrderByFromFleet`); all-clear form "Fleet is healthy — no orders due before **<horizon>**." Sub-deck instrument row: utilization (linear bullet meter with warn/crit ticks — no radial gauges), headroom GB, clusters · hosts count, open-order count (order-bys within 90 days), and **Baselines** (count of clusters with `baselineDate` older than 90 days; warn-toned when > 0, "all fresh" otherwise).
4. **Cluster tile grid** — 12-col grid, tiles `span 4` (3-up ≥1280 px, 2-up ≥820 px, 1-up below). One uniform tile per non-archived cluster, **sorted by order-by date ascending, nulls last, runway tiebreak**, with a "sorted by order-by date" micro-note. Tile contents: name + status chip (`utilStatus`) + flag chips (archived, license/lifecycle notes are out of scope — flags shown: event within window, stale baseline); runway numeral line ("9 MO to warn 2027-04" / "24+ MO no breach"); order-by chip ("ORDER BY 2026-12-28 · IN 5 MO", tone by urgency; "— · no order needed" when null); one-line verdict sentence; baseline chip ("BASELINE 2026-06-20", warn variant "⚠ BASELINE 128 D OLD" past 90 days); a compact Recharts forecast chart — **shared 0–125 %-of-capacity y-scale across all tiles**, warn/crit hairlines + 100% capacity line, consumption solid to the current month then dashed (forecast), labeled breach dot and order-by marker, hover tooltip. _Recorded exception (2026-07-17):_ compact tile charts omit standalone event markers, matching the approved mockup; events surface in breach sub-labels on tiles and as full markers on the detail chart. Reason: legibility at tile scale; risk: low (detail chart carries them); approver: design lead per approved mockup; review: at final branch review. Clicking/Enter navigates to `/clusters/$id`. _Amended 2026-07-17:_ the runway numeral example above reads "9 MO to warn 2027-04" (was "to crit") — the numeral always tracks the warn-threshold breach month (`computeRunway`'s `breachLabel: 'warn'` case), matching `runwayToWarn`; crit only appears in the past-breach sub-line/verdict text once the fleet is already past warn. _Amended 2026-07-18 (#224):_ two changes to the compact tile chart. (1) **Axes are now labeled** — the x-axis shows short month names (`formatMonthShort`, `interval="preserveStartEnd"` so they thin at tile width) and the y-axis shows a few percent ticks; margins/axis sizing were adjusted from the previous hidden-axes layout. (2) **The shared y-scale is tightened from 0–125 % to 40–125 %** — real clusters sit well above 40 %, so the old scale wasted its bottom third and squeezed the warn/crit band into a top sliver. The window stays **fixed and identical across all tiles** (the comparability invariant is preserved), enforced with Recharts `allowDataOverflow` so out-of-range data can never stretch the axis: below-floor values (notably zero/unknown-capacity synced clusters at 0 %, per #198) are clamped to the 40 % floor so their line stays visible pinned to the bottom edge, while the tooltip still reports the true percentage; above-ceiling values (>125 %) clamp to the top as before. **Color deviation:** the consumption line moves off amber to a dedicated violet (`--chart-consumption` = `#7c3aed` light / `#c084fc` dark, split from `--accent`). House style reserves amber for brand+data, but amber is double-booked as the warn-threshold color (`--warning`), so in dark theme the usage line and the warn hairline were the identical hex — indistinguishable. The warn threshold keeps amber (its semantic status color); the consumption line takes violet, which clears warn amber, crit red, success green, and the steel interaction hue in both themes. `--steel` was explicitly rejected (reserved for interaction/focus, and already used for the tile's order-by marker). This also recolors the cluster-detail `ForecastChart`, which shares `--chart-consumption`.
5. **Console controls** — "+ Add cluster" (AdminOnly, existing `CreateClusterDialog`) and "Show archived" toggle (archived clusters append as muted tiles, runway shown as "—"). _Amended 2026-07-17:_ the controls render as a slim toolbar row between the rail and the verdict panel (not below the grid); the numbered list orders content, not strict visual position for this item. The `ClusterTable`, `FleetUtilizationHeatmap`, `FleetClusterGrid`, `KpiTile` row and `ClusterListCard` are retired. _Amended 2026-07-18 (#223):_ "+ Add cluster" is removed from the console entirely — manually adding a cluster is a configuration task and now lives in an AdminOnly Settings panel (below vCenter connections), leaving "Show archived" as the only console control. The empty console shows a large AdminOnly Add-cluster call-to-action in the tile-grid area that links to Settings (viewers get a plain explanation instead); the ⌘K "Create cluster" action navigates to `/settings` and is hidden from viewers (it previously dispatched `lcm:open-create-cluster`, now removed).

## 5. Detail slide-in panel (`/clusters/$id`)

Fixed right panel, 58 vw (min 600 px; 100 vw < 1100 px), entering/exiting per the motion spec; the console remains beneath. Esc or ✕ navigates to `/`; focus is moved into the panel on open and restored on close. Content preserves the current detail page's functionality, restyled: _Amended 2026-07-17:_ the panel opens as a fullscreen takeover — 100 vw at every width (the 58 vw / min-600 px / 1100 px-breakpoint geometry and the partial-panel left border/shadow are retired) — user decision after using the shipped UI; the slide-in/out motion, Esc/✕, focus management, and inert console beneath are unchanged.

1. Header: name, description, baseline chip (with stale warning), archived badge.
2. **Recommendation banner** (new): verb-first line from `deriveProcurementKpi` — e.g. "Order capacity — last safe order date 2026-12-28 (in 5 mo, 6-wk lead)."; crit tone when overdue/≤28 d; omitted when no breach ("No order needed in this window.").
3. KPI strip (existing `kpi-strip` testid): utilization (bullet meter replaces the radial `UtilizationGauge` here; gauge component is retired), headroom, runway, order-by.
4. Forecast section: heading states the finding ("Forecast — warn ≈ 2027-04 · order by 2026-12-28", scenario-aware), `WindowControls`, `ForecastChart` with: solid/dashed actual-vs-forecast consumption split at the current month, and **scenario ghost** — when a scenario is active the scenario series is the active line and the baseline consumption + baseline breach stay visible as muted ghosts with a "was: …" label and a delta callout ("▲ N mo earlier/later"). _Amended 2026-07-17:_ the heading example above reads "Forecast — warn ≈ 2027-04 · order by 2026-12-28" (was "crit ≈") — `forecastHeading` computes its finding via `runwayToWarn`, matching the tile numeral's warn semantics in §4.4.
5. `ScenarioControls` unchanged functionally (lose_hosts / add_vms / delay_procurement).
6. Tabs (Hosts / Apps & Events / Settings) with all existing dialogs and forms. **Hosts tab upgrade:** the Commissioned/Decommissioned/Warranty/EOL date columns are replaced by one **Lifecycle** Gantt cell — shared time axis across rows (min commissioned → max EOL), labeled NOW line, bar commissioned→EOL, warranty tick (warn-styled "WTY EXPIRED" when past), EOL date text at bar end; full dates remain in the expanded row and in each cell's aria-label/tooltip. Settings tab: `ClusterLifecycleCard` delete now navigates to `/`.

## 6. Accessibility & quality floor

WCAG 2.2 AA: global `:focus-visible` two-layer ring (≥2 px, ≥3:1 on every surface); interactive targets ≥24 px (invisible hit-area padding on rail ticks); tile grid keyboard-operable (tiles are links/buttons); panel focus management + `aria-live` announcements for open/close and scenario deltas; status chips always pair color with text; charts get halos on labels crossing marks; reduced-motion honored everywhere. Both themes ship together and every screen must pass in both.

## 7. Out of scope (recorded)

Forecast uncertainty bands (engine is deterministic — do not fabricate), action-queue view (removed by user), per-cluster lead times, chart PNG export, mockup-only calm/dramatized toggle (the real app's calm state emerges from real data), `FleetUtilizationHeatmap` successor, new backend endpoints.

## 8. Verification

Every task passes `pnpm lint && pnpm typecheck && pnpm --filter @lcm/web test`; the final task runs the full suite + build, rewrites the five affected Playwright specs (golden-path, layout, mobile, settings, oidc-layout + scroll-containment helper), and verifies both themes visually against the dev stack. CLAUDE.md's "UI/UX: House Style" section is updated to the new tokens/fonts in the same branch.
