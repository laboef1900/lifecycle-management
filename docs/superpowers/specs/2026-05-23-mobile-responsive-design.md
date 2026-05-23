# Mobile responsiveness — design spec

**Date:** 2026-05-23
**Status:** Approved, ready for implementation plan
**Scope:** Make the app usable on phones (390–420 px) and small tablets without
regressing the desktop experience. The current layout fixes a 240 px sidebar
into every viewport, leaving phone users with ~160 px of content area and
clipping KPI numbers, breadcrumbs, and cluster names.

## Why

Manual Playwright verification at 390 × 844 and 768 × 1024 (Chrome) shows:

- The sidebar consumes 58 % of viewport at phone width and 30 % at tablet
  width. Everything in the main area gets squeezed.
- KPI tile values clip at 390 px ("28,596 GB" cut to "28,596", "24+ mo" cut
  to "24+ m") because `text-3xl` is wider than the available column.
- The cluster-detail H1 ("CL-Prod-P2") breaks on its hyphens to three lines.
- The "limited by CL-Prod-P2" caption breaks similarly.
- The clusters table at 390 px overflows horizontally inside its Card,
  rendering with awkward column widths and truncated cell contents.
- The chart threshold labels ("Crit 54,835") still render but consume 14 %
  of the chart width at phone size, squeezing the plot.

The product is otherwise usable; the layout shell is the gating problem.

## What changes

### 1. Sidebar collapses to an overlay drawer below `lg:` (1024 px)

- New shadcn `<Sheet>` primitive at `apps/web/src/components/ui/sheet.tsx`,
  built on `@radix-ui/react-dialog` (already in the repo for the existing
  `<Dialog>`). Slides from the left, 260 px wide, dimmed backdrop with
  `backdrop-blur-sm`. Closes on backdrop click, Escape, or link click
  inside the sheet.
- The existing `<Sidebar>` is split into a reusable `<SidebarNav>` (the
  nav `<ul>`) and the chrome around it. `<SidebarNav>` renders inside both
  the inline aside (`lg:` and up) and the Sheet body (below `lg:`).
- A new `<MobileNavTrigger>` (hamburger button using `lucide-react`'s
  `Menu` icon) appears in the header at `< lg:`. It opens the Sheet via
  shared state (a small `useMobileNav()` hook that wraps a `useState`
  inside a context provider at the `AppShell` level).
- The existing "Collapse" button stays only at `lg:` and up.
- The inline aside is `hidden lg:flex`, so it does not consume layout space
  below 1024 px.

### 2. Header trim below `md:`

- `<MobileNavTrigger>` button on the left, only visible at `< lg:`.
- Logo + "Capacity Forecast" wordmark stays. Wordmark hidden at `< sm:`
  (already true today via `hidden sm:inline`).
- Breadcrumbs already hide at `< md:` — no change.
- `<ApiHealthPill>` renders as a 6 × 6 px colored dot with a `title`
  attribute at `< sm:`. The full pill returns at `sm:` and up.
- `<CommandPaletteTrigger>` becomes an icon-only button at `< sm:` (just
  the Search icon, no "Ctrl K" hint). The full pill returns at `sm:` and
  up.
- Theme toggle stays as-is at all widths.

### 3. KPI tile robustness

- Value font scales: `text-2xl sm:text-3xl`. Avoids clipping at phone
  width.
- Add `[overflow-wrap:anywhere]` on the value and caption containers.
  Prevents "CL-Prod-P2" from forcing hyphen breaks and keeps long cluster
  IDs flowing naturally.
- Eyebrow label is left untouched — the existing `text-[11px]` already
  wraps acceptably.

### 4. Cluster-detail H1

Apply `[overflow-wrap:anywhere]` to the H1 on `/clusters/:id`. This is
defense for long cluster names; the sidebar collapse already gives ~370 px
of horizontal room, which fits the seeded names at the current font size.

### 5. Clusters list — cards below `md:`, table above

Inside `<ClusterTable>`:

- At `< md:`, render the rows as a vertical stack of `<ClusterListCard>`
  components. Each card is a `<Link>` to the cluster detail page with:
  - Top row: cluster name (large) + utilization badge (right).
  - Second row: `consumption / capacity GB` in small mono.
  - Bottom row: runway pill.
- At `md:` and up, the existing table renders unchanged.
- Sort controls disappear in the card stack (there is no header row).
  Cards are rendered in the same sorted order as the table when the user
  toggles a header at a wider width and then resizes down. Default is
  name ascending.

### 6. Chart label compaction below `sm:`

`<FleetCapacityChart>` and `<ForecastChart>` accept a new optional
`compact?: boolean` prop. When `compact` is true:

- ReferenceLine `label` value strings are suppressed (the lines still
  render).
- Chart `margin.right` reduces to `16` (no need to make room for label
  text).
- Y-axis tick `fontSize` drops from 11 to 10 to claw back more plot width.

Each route reads `useMediaQuery('(min-width: 640px)')` (or
`useSyncExternalStore` over `matchMedia`) and passes the boolean to the
chart. The `useMediaQuery` hook is a new file at
`apps/web/src/lib/use-media-query.ts`.

## Out of scope

- Bottom tab bar pattern (Recommended option was the drawer).
- `/clusters/new` and `/settings` empty-state polish.
- Print stylesheet.
- Landscape phone orientation tweaks beyond what falls out of the above.
- Theme toggle menu (a separate deferred polish item).

## Data

No API or schema changes. The `useMediaQuery` hook is the only new runtime
dependency on `window.matchMedia`, which already exists in
`theme-provider.tsx`.

## Edge cases

| Case                                                             | Behavior                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Browser at exactly 1024 px                                       | `lg:` breakpoint fires (Tailwind's `lg` is `min-width: 1024px`). Inline sidebar shows; hamburger hidden. |
| Resize from desktop → mobile with sidebar open                   | The inline aside disappears; Sheet state stays closed (the two are independent).                         |
| Resize from mobile → desktop with Sheet open                     | Sheet closes automatically (Sheet is unmounted when its trigger isn't rendered).                         |
| User in Sheet taps a navigation link                             | Navigates and Sheet auto-closes.                                                                         |
| User taps the backdrop                                           | Sheet closes.                                                                                            |
| User presses Escape                                              | Sheet closes (Radix Dialog default).                                                                     |
| Pre-existing `sidebar` localStorage key (`expanded`/`collapsed`) | Unchanged — controls the inline sidebar's collapse state at `lg:` only.                                  |
| Cluster card at 390 px with a 30-character cluster name          | `[overflow-wrap:anywhere]` lets the name break gracefully; the link still hits the cluster row.          |
| Chart at 320 px (extreme small)                                  | `compact` mode is active; chart still renders, axis ticks readable, plot is the dominant element.        |

## Files

**New**

- `apps/web/src/components/ui/sheet.tsx` — shadcn Sheet primitive (Radix Dialog under the hood).
- `apps/web/src/components/layout/mobile-nav.tsx` — `<MobileNavTrigger>` + `useMobileNav()` context.
- `apps/web/src/lib/use-media-query.ts` — `useMediaQuery(query)` hook.
- Unit tests alongside each.

**Modified**

- `apps/web/src/components/layout/app-shell.tsx` — wrap children in a `MobileNavProvider`; render Sheet around `<Sidebar>` below `lg:`; add hamburger to header; trim header items at `< sm:`.
- `apps/web/src/components/layout/sidebar.tsx` — extract `<SidebarNav>`; mark the aside `hidden lg:flex`; close the sheet when a nav link is clicked.
- `apps/web/src/components/overview/kpi-tile.tsx` — value `text-2xl sm:text-3xl` + `[overflow-wrap:anywhere]` on value & caption.
- `apps/web/src/routes/clusters.$id.tsx` — `[overflow-wrap:anywhere]` on H1; pass `compact` to the forecast chart.
- `apps/web/src/routes/index.tsx` — pass `compact` to the fleet chart.
- `apps/web/src/components/clusters/cluster-table.tsx` — add `<ClusterListCard>` rendering inside `md:hidden` wrapper.
- `apps/web/src/components/overview/fleet-capacity-chart.tsx` — accept `compact`, suppress label values + tighten margin when set.
- `apps/web/src/components/clusters/forecast-chart.tsx` — same `compact` treatment.

## Testing

**Unit**

- `useMediaQuery` — boolean response, subscribes to `change` events, unsubscribes on unmount, SSR-safe default.
- `<Sheet>` — opens/closes via state, closes on backdrop click, traps focus (Radix gives us most of this; we assert wrapper behavior).
- `<MobileNavTrigger>` — opens the sheet, shows the menu icon, hides above `lg:` (via class assertion).
- `<ClusterListCard>` — renders cluster name, utilization badge, used/cap, runway pill, link href correct.
- Update `<ClusterTable>` test: at the default jsdom width (1024) the existing table tests pass; add a media-query mock that asserts the card stack renders at narrow widths.

**E2E (extends existing Playwright golden path)**

- A new dedicated `mobile.spec.ts`: at `viewport: { width: 390, height: 844 }`, visit `/`, confirm hamburger is visible, click it, confirm Sheet opens with three nav links, navigate to `/clusters`, confirm card stack renders (no table column headers visible at this width).

## Definition of done

- `pnpm --filter @lcm/web test` green (existing 61 + new ~10).
- `pnpm --filter @lcm/web test:e2e` green, including the new mobile spec.
- `pnpm typecheck` and `pnpm lint` clean.
- Manual Playwright verification at 390 × 844 and 768 × 1024, light + dark:
  - Sidebar is hidden inline; hamburger present in header.
  - Tapping hamburger opens the drawer; backdrop closes it; nav links navigate and auto-close.
  - KPI tile values fit on one line at 390 px.
  - Cluster-detail H1 renders without hyphen-break.
  - `/clusters` shows card stack below `md:` and the existing table at `md:` and above.
  - Charts render without label clipping at narrow widths; tooltip still shows the threshold values on hover.
- No regression at desktop (≥ 1024 px): sidebar is inline, collapse button works, all existing behavior intact.
