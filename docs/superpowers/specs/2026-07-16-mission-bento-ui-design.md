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
4. **Cluster tile grid** — 12-col grid, tiles `span 4` (3-up ≥1280 px, 2-up ≥820 px, 1-up below). One uniform tile per non-archived cluster, **sorted by order-by date ascending, nulls last, runway tiebreak**, with a "sorted by order-by date" micro-note. Tile contents: name + status chip (`utilStatus`) + flag chips (archived, license/lifecycle notes are out of scope — flags shown: event within window, stale baseline); runway numeral line ("9 MO to crit 2027-04" / "24+ MO no breach"); order-by chip ("ORDER BY 2026-12-28 · IN 5 MO", tone by urgency; "— · no order needed" when null); one-line verdict sentence; baseline chip ("BASELINE 2026-06-20", warn variant "⚠ BASELINE 128 D OLD" past 90 days); a compact Recharts forecast chart — **shared 0–125 %-of-capacity y-scale across all tiles**, warn/crit hairlines + 100% capacity line, consumption solid to the current month then dashed (forecast), labeled breach dot and order-by marker, event markers, hover tooltip. Clicking/Enter navigates to `/clusters/$id`.
5. **Console controls** — "+ Add cluster" (AdminOnly, existing `CreateClusterDialog`) and "Show archived" toggle (archived clusters append as muted tiles). The `ClusterTable`, `FleetUtilizationHeatmap`, `FleetClusterGrid`, `KpiTile` row and `ClusterListCard` are retired.

## 5. Detail slide-in panel (`/clusters/$id`)

Fixed right panel, 58 vw (min 600 px; 100 vw < 1100 px), entering/exiting per the motion spec; the console remains beneath. Esc or ✕ navigates to `/`; focus is moved into the panel on open and restored on close. Content preserves the current detail page's functionality, restyled:

1. Header: name, description, baseline chip (with stale warning), archived badge.
2. **Recommendation banner** (new): verb-first line from `deriveProcurementKpi` — e.g. "Order capacity — last safe order date 2026-12-28 (in 5 mo, 6-wk lead)."; crit tone when overdue/≤28 d; omitted when no breach ("No order needed in this window.").
3. KPI strip (existing `kpi-strip` testid): utilization (bullet meter replaces the radial `UtilizationGauge` here; gauge component is retired), headroom, runway, order-by.
4. Forecast section: heading states the finding ("Forecast — crit ≈ 2027-04 · order by 2026-12-28", scenario-aware), `WindowControls`, `ForecastChart` with: solid/dashed actual-vs-forecast consumption split at the current month, and **scenario ghost** — when a scenario is active the scenario series is the active line and the baseline consumption + baseline breach stay visible as muted ghosts with a "was: …" label and a delta callout ("▲ N mo earlier/later").
5. `ScenarioControls` unchanged functionally (lose_hosts / add_vms / delay_procurement).
6. Tabs (Hosts / Apps & Events / Settings) with all existing dialogs and forms. **Hosts tab upgrade:** the Commissioned/Decommissioned/Warranty/EOL date columns are replaced by one **Lifecycle** Gantt cell — shared time axis across rows (min commissioned → max EOL), labeled NOW line, bar commissioned→EOL, warranty tick (warn-styled "WTY EXPIRED" when past), EOL date text at bar end; full dates remain in the expanded row and in each cell's aria-label/tooltip. Settings tab: `ClusterLifecycleCard` delete now navigates to `/`.

## 6. Accessibility & quality floor

WCAG 2.2 AA: global `:focus-visible` two-layer ring (≥2 px, ≥3:1 on every surface); interactive targets ≥24 px (invisible hit-area padding on rail ticks); tile grid keyboard-operable (tiles are links/buttons); panel focus management + `aria-live` announcements for open/close and scenario deltas; status chips always pair color with text; charts get halos on labels crossing marks; reduced-motion honored everywhere. Both themes ship together and every screen must pass in both.

## 7. Out of scope (recorded)

Forecast uncertainty bands (engine is deterministic — do not fabricate), action-queue view (removed by user), per-cluster lead times, chart PNG export, mockup-only calm/dramatized toggle (the real app's calm state emerges from real data), `FleetUtilizationHeatmap` successor, new backend endpoints.

## 8. Verification

Every task passes `pnpm lint && pnpm typecheck && pnpm --filter @lcm/web test`; the final task runs the full suite + build, rewrites the five affected Playwright specs (golden-path, layout, mobile, settings, oidc-layout + scroll-containment helper), and verifies both themes visually against the dev stack. CLAUDE.md's "UI/UX: House Style" section is updated to the new tokens/fonts in the same branch.
