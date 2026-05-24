# Graphite + Honey operator console — design spec

**Date:** 2026-05-24
**Status:** Approved, ready for implementation plan
**Scope:** Replace the current "graphite + blue" visual system with an
operator-console aesthetic on graphite surfaces with a honey accent.
Drops generic blue primary, gradient logo, header/sidebar backdrop blur,
and `oklch()` neutrals in favor of flat hex tokens, monospace numerals,
and tightly-rationed accent use.

## Why

The user compared lifecycle-management to two sibling projects
(Compendiq and ai-portainer-dashboard) and felt this one looked less
professional. Compendiq has a strong editorial brand (honey on
graphite, Newsreader/Hanken typography, neumorphic surfaces);
ai-portainer-dashboard has heavy visual identity (glassmorphism,
multiple themes). Lifecycle-management's recent graphite-polish landed
a calmer dark mode but kept a generic blue accent and otherwise reads
as an unstyled shadcn baseline.

The chosen direction (after side-by-side comparison of three full
palettes in light + dark) is:

- **Operator console** (Linear / Vercel / Datadog family) — flat
  surfaces, razor-thin borders, monospace numerals, tight density. The
  data is the design.
- **Graphite + Honey** palette — same `#F9C74F` honey as Compendiq, so
  the two products read as siblings. Honey darkens to `#8A6016` in
  light mode for AA contrast (same trick Compendiq uses).
- **Follows system preference** — no opinionated default; ships both
  themes at parity.

## Design principles

1. **The data is the design.** Surfaces stay flat. Borders are
   razor-thin (1px, ~6% opacity). No shadows except on overlays
   (modals, popovers, command palette). Nothing competes with the
   numbers.
2. **Honey is rationed.** The accent never appears as a generic
   "primary." It marks only:
   - the single most-load-bearing number per view (the headline KPI —
     typically fleet runway),
   - the focused chart series,
   - the active nav item,
   - primary CTAs.

   A view with three honey accents is broken — the focus is lost.

3. **Monospace where precision matters.** Numerals, IDs, durations,
   percentages, dates are typeset in JetBrains Mono. Prose stays in
   Inter. The eye locks onto data because it's set differently.

## What changes

### 1. Type system

No font swaps — Inter + JetBrains Mono are already loaded. The change
is a new type scale applied via Tailwind utilities and a small set of
component-level conventions.

| Token        | Family         | Size | Weight | Letter spacing   |
| ------------ | -------------- | ---- | ------ | ---------------- |
| `display`    | Inter          | 26px | 600    | -0.02em          |
| `h1`         | Inter          | 20px | 600    | -0.015em         |
| `h2`         | Inter          | 16px | 600    | -0.01em          |
| `body`       | Inter          | 14px | 400    | 0                |
| `label`      | Inter          | 10px | 500    | 0.12em UPPERCASE |
| `caption`    | Inter          | 11px | 500    | 0                |
| `numeric-lg` | JetBrains Mono | 20px | 500    | 0                |
| `numeric`    | JetBrains Mono | 14px | 500    | 0                |
| `code`       | JetBrains Mono | 12px | 400    | 0                |

The current overview page already uses a custom `text-[1.625rem]` for
the H1 — that becomes `display` (26px ≈ 1.625rem; same value, named
token). Other headings, labels, and captions get the same named
tokens.

### 2. Color tokens (replace OKLCH with hex)

Drops all `oklch()` neutral values and the blue primary. Replaces
with the hex palette below. Honey is the single accent in both modes.

| Token           | Dark                    | Light                  |
| --------------- | ----------------------- | ---------------------- |
| `--background`  | `#0a0a0a`               | `#fafafa`              |
| `--card`        | `#111111`               | `#ffffff`              |
| `--card-hover`  | `#161616`               | `#f7f7f7`              |
| `--popover`     | `#161616`               | `#ffffff`              |
| `--muted`       | `#1a1a1a`               | `#f5f5f5`              |
| `--border`      | `#262626` (~6% wht)     | `#e5e5e5` (~6% blk)    |
| `--input`       | `#262626`               | `#e5e5e5`              |
| `--foreground`  | `#fafafa`               | `#0a0a0a`              |
| `--fg-muted`    | `#a3a3a3`               | `#525252`              |
| `--fg-subtle`   | `#737373`               | `#737373`              |
| `--ring`        | `#f9c74f`               | `#8a6016`              |
| `--accent`      | `#f9c74f` (honey)       | `#8a6016` (honey-ink)  |
| `--accent-soft` | `rgba(249,199,79,0.15)` | `rgba(138,96,22,0.10)` |
| `--success`     | `#4ade80`               | `#15803d`              |
| `--warning`     | `#f59e0b`               | `#b45309`              |
| `--destructive` | `#f87171`               | `#b91c1c`              |

Drops these tokens entirely:

- `--primary`, `--primary-foreground` — replaced by `--accent` /
  `--foreground`. Buttons that were `variant="primary"` become
  `variant="accent"` (honey fill, dark text) or `variant="default"`
  (solid foreground, light text).
- `--secondary`, `--secondary-foreground` — unused after the
  re-skin; collapse into `--muted` / `--fg-muted`.
- `--success-strong`, `--warning-strong`, `--destructive-strong` —
  the `-strong` variants existed for the previous high-saturation
  scheme. With the new palette, status colors are used at one
  intensity only.
- `--radius-card` keeps a separate value (see §3) but the
  `--shadow-card` token is removed (no shadows on cards).

### 3. Surface, radius, density

**Surfaces — flat with borders, no shadows.**

| Token            | Current | New     |
| ---------------- | ------- | ------- |
| `--radius`       | 0.5rem  | 6px     |
| `--radius-card`  | 0.75rem | 8px     |
| `--radius-modal` | 1rem    | 12px    |
| `--shadow-card`  | present | removed |

Overlays (Dialog, Popover, Command palette, Tooltip) keep a
shadow — set per-component, not via a global token:

- Dark: `0 8px 24px rgba(0,0,0,0.32), 0 2px 4px rgba(0,0,0,0.20)`
- Light: `0 8px 24px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04)`

Drops the `bg-card/70 backdrop-blur-xl` treatment on the header
(`app-shell.tsx`) and sidebar (`sidebar.tsx`). Both become solid
`--background` with a single border on the touching edge (bottom for
header, right for sidebar).

**Density.**

| Surface            | Current | New  |
| ------------------ | ------- | ---- |
| Page padding       | 16/24px | 24px |
| Grid gap (tiles)   | 16px    | 8px  |
| Tile padding       | 16px    | 14px |
| Table row height   | ~44px   | 36px |
| Button height (sm) | n/a     | 28px |
| Button height (md) | 36px    | 32px |
| Button height (lg) | n/a     | 36px |

The grid-gap reduction is the most-noticeable density shift on
the overview page. Tiles read as a continuous data surface rather
than as a constellation of cards.

**Motion.**

- Keep the existing `150ms cubic-bezier(0.4,0,0.2,1)` transitions.
- Remove all hover-translate effects (no `translateY(-2px)` lift).
  Hover state = subtle background tint shift only.
- `@media (prefers-reduced-motion: reduce)` overrides all motion
  durations to 0s.

### 4. Status colors and the headline-metric rule

The current code threads `status: 'ok' | 'warn' | 'crit'` through
`KpiTile`, `RunwayPill`, and `UtilizationGauge`. Each value maps to
a foreground color. New mapping:

| Status      | Color                 | When                                     |
| ----------- | --------------------- | ---------------------------------------- |
| `ok`        | `--fg-muted` (gray)   | metric within healthy range              |
| `attention` | `--accent` (honey)    | this is the headline insight on the view |
| `warn`      | `--warning` (amber)   | breach within the forecast horizon       |
| `crit`      | `--destructive` (red) | already breached or imminent (<3 mo)     |

The previous mapping used green for `ok` on the headline metric.
The new rule replaces "everything's fine = green" with two
explicit states:

- **The headline metric uses `attention` (honey) whenever its
  status is not `warn` or `crit`.** On the overview page the
  fleet-runway tile is the headline, so it reads in honey unless
  a real threshold is breached.
- **All other tiles use `ok` (gray) for the healthy state.** This
  is what creates the "data is the design" effect — only one tile
  per view draws the eye on color alone.

**Type changes in `apps/web/src/lib/forecast-summary.ts`:**

The existing `UtilStatus = 'ok' | 'warn' | 'crit'` type stays
unchanged — `utilStatus()` never returns `'attention'` (utilization
is always categorical: healthy / warn / crit).

Adds a new `KpiStatus = UtilStatus | 'attention'` type for KPI-tile
status. The `'attention'` value is a presentational marker, not a
threshold band — it's chosen by the _caller_ (the overview page),
not derived from a metric. Consumers (`KpiTile`, `RunwayPill`,
`UtilizationGauge`) accept `KpiStatus` and render `'attention'` as
honey.

In `routes/index.tsx`, the `runwayStatus` computation gets one new
branch: when the fleet has no breach and is not already breached,
return `'attention'` instead of `'ok'`. The warn/crit branches
keep returning the actual threshold status. This makes runway the
only headline metric on the page.

**Charts (Recharts theming, driven by
`apps/web/src/lib/use-chart-colors.ts`):**

- **Single-series charts** (one cluster's forecast): line uses
  `--accent` (honey). Capacity ceiling line uses
  `--destructive` at 50% opacity. Grid and axis use `--border` and
  `--fg-subtle`.
- **Multi-series charts** (fleet overview, multi-cluster comparison):
  cluster lines use a **5-step grayscale palette** rather than
  rainbow colors. The hovered or actively-selected cluster
  promotes to `--accent` (honey). At most one series is ever
  honey at a time.
  - Dark palette: `#e5e5e5`, `#a3a3a3`, `#737373`, `#525252`,
    `#404040` (cycled if >5 clusters).
  - Light palette: `#171717`, `#404040`, `#525252`, `#737373`,
    `#a3a3a3` (cycled if >5 clusters).
- **Reference lines** for the 70% warn / 90% crit thresholds use
  `--border` (light) / `#262626` (dark) with `strokeDasharray="4 4"`.
- **Event markers** (growth, hardware_change, openshift, note): keep
  category distinction but desaturate — use a 4-step monochrome
  gray scale, not the current rainbow. Differentiate by marker
  _shape_ (circle / square / triangle / diamond) if categorical
  identity matters.

This is a full rewrite of `use-chart-colors.ts`. The exported
`ChartColors` interface stays the same shape (consumers don't
break); the values become hex-based and align with the §2 token
palette.

### 5. Component-level changes

| File                                                        | Change                                                                                                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/styles.css`                                   | Full token rewrite per §1–§3. Drop OKLCH neutrals, blue primary, gradient body, `--shadow-card`. Add new font sizes.                                                        |
| `apps/web/src/components/ui/button.tsx`                     | Add `accent` variant (honey fill, dark text). Rename existing `primary` consumers to `accent`. New heights (28/32/36).                                                      |
| `apps/web/src/components/ui/card.tsx`                       | Flat: no shadow, border only, new radius. Remove any `bg-card/N` opacity classes.                                                                                           |
| `apps/web/src/components/ui/badge.tsx`                      | Re-skin: monochrome border + soft fill per status. Drop the gradient/glow variants if present.                                                                              |
| `apps/web/src/components/ui/input.tsx`                      | Flat: solid background, 1px border, 6px radius. No focus shadow — focus = honey ring (1px solid `--ring`).                                                                  |
| `apps/web/src/components/ui/select.tsx`                     | Same flat treatment. Popover gets the overlay shadow.                                                                                                                       |
| `apps/web/src/components/ui/table.tsx`                      | New 36px row height, 1px row dividers, hover = `--card-hover`.                                                                                                              |
| `apps/web/src/components/ui/tabs.tsx`                       | Active tab = honey underline (2px), inactive = `--fg-subtle`. No background pill.                                                                                           |
| `apps/web/src/components/ui/tooltip.tsx`                    | Solid `--popover` background, overlay shadow, 12px radius (modal-scale).                                                                                                    |
| `apps/web/src/components/ui/dialog.tsx`                     | Modal radius (12px), overlay shadow, solid background. Backdrop = `rgba(0,0,0,0.5)`.                                                                                        |
| `apps/web/src/components/ui/sheet.tsx`                      | Same overlay treatment as dialog.                                                                                                                                           |
| `apps/web/src/components/ui/runway-pill.tsx`                | Support new `attention` status (honey). Update test snapshots.                                                                                                              |
| `apps/web/src/components/ui/utilization-gauge.tsx`          | Same — `attention` status path, honey ring color.                                                                                                                           |
| `apps/web/src/components/overview/kpi-tile.tsx`             | Use `numeric-lg` mono for the value. 14px tile padding. Left accent bar (2px, honey) when status is `attention/warn/crit`.                                                  |
| `apps/web/src/components/overview/cluster-tile.tsx`         | Flatten, tighten, mono numerals.                                                                                                                                            |
| `apps/web/src/components/overview/fleet-capacity-chart.tsx` | Re-theme per §4 (honey focused series, gray others, dashed border reference lines). Adds hover-to-focus interaction so the hovered cluster line promotes to honey.          |
| `apps/web/src/components/clusters/forecast-chart.tsx`       | Single-series re-theme: honey forecast line, dashed reference lines, gray axis.                                                                                             |
| `apps/web/src/components/clusters/utilization-panel.tsx`    | Consumes the new chart-color values. Re-skin panel surfaces (flat + border).                                                                                                |
| `apps/web/src/lib/use-chart-colors.ts`                      | Full rewrite per §4 — hex values aligned with the §2 token palette; grayscale `clusterPalette`; monochrome event markers. Same exported interface shape.                    |
| `apps/web/src/components/layout/app-shell.tsx`              | Drop gradient logo wrapper (`bg-gradient-to-br from-primary to-primary/70`). Replace with `bg-accent` square + dark `Activity` icon. Drop `backdrop-blur-xl` on the header. |
| `apps/web/src/components/layout/sidebar.tsx`                | Drop `bg-card/60 backdrop-blur-xl` → solid `bg-background` + right border. Active item: 2px honey left border + foreground text (replaces inset shadow + muted bg).         |
| `apps/web/src/routes/index.tsx`                             | New eyebrow label "Capacity Forecast"; H1 uses `display` token; runway tile is the `attention` headline metric.                                                             |
| `apps/web/src/routes/clusters.index.tsx`                    | Same token cascade — no structural changes, just renders correctly under the new tokens.                                                                                    |
| `apps/web/src/routes/clusters.$id.tsx`                      | Same.                                                                                                                                                                       |
| `apps/web/src/routes/clusters.new.tsx`                      | Same. Form inputs already use the re-skinned `Input`/`Select`/`Button`.                                                                                                     |
| `apps/web/src/routes/settings.tsx`                          | Light pass — token cascade only. No structural redesign.                                                                                                                    |
| `apps/web/src/lib/forecast-summary.ts`                      | Add `KpiStatus = UtilStatus \| 'attention'` type. `utilStatus()` unchanged. (Headline-metric branch added in `routes/index.tsx`, not here.)                                 |

Scope estimate: ~20 files modified; the bulk is token-driven so changes
cascade and individual diffs are small. One PR.

## Out of scope

- Routing, data fetching, query logic, business logic — untouched.
- Component APIs (prop names/shapes) — unchanged. Internal styling
  only.
- Mobile responsive layout — shipped recently in
  `2026-05-23-mobile-responsive`, no rework.
- Forms / Settings page deep redesign — token cascade only, no
  structural change.
- No new dependencies. No new theme variants. No glass /
  neumorphism / gradient-mesh treatments. No font swaps.
- The `--success` / `--warning` / `--destructive` tokens stay
  in the codebase for non-headline status pills (e.g. API-health
  badge in the header). They are not deleted, just re-valued.

## Files

**Modified:** see the component-level table in §5. Roughly 20 files,
mostly in `apps/web/src/components/ui/`,
`apps/web/src/components/overview/`,
`apps/web/src/components/layout/`, plus `styles.css`, `routes/`, and
`lib/forecast-summary.ts`.

**No new files.** No new dependencies.

## Testing

The change is overwhelmingly visual. Functional tests should remain
green without modification; snapshot tests that capture
class strings or rendered colors will need to be updated.

**Automated:**

- `pnpm --filter @lcm/web test` — green. Snapshot updates for
  `runway-pill.test.tsx`, `utilization-gauge.test.tsx`,
  `cluster-tile.test.tsx`, `sheet.test.tsx`, `mobile-nav.test.tsx`
  are expected; review each diff to confirm only colors/classes
  change.
- `pnpm --filter @lcm/web typecheck` — clean. The
  `'attention'` status addition requires updating all consumers of
  the `RunwayStatus` union.
- `pnpm --filter @lcm/web lint` — clean.
- `pnpm --filter @lcm/web test:e2e` — green. Existing Playwright
  tests verify structure, not pixel color; should pass without
  changes.

**Manual visual verification** (Playwright screenshots at 1440 × 900,
both themes):

- Overview page: H1 in `display`, eyebrow label, three KPI tiles in
  tight 8px grid, runway tile is honey (`attention`), other tiles
  gray, fleet chart shows honey focused line + gray reference lines.
- Clusters list: dense 36px rows, no card shadows, hover row
  background = `--card-hover`.
- Cluster detail: chart renders with honey focused series and
  dashed reference lines.
- Settings: forms render under new tokens with no layout breakage.
- Mobile (390 × 844): sheet drawer opens, sidebar nav renders
  identically to desktop sidebar (no `backdrop-blur`), active item
  has honey left border.
- Header: simple honey square logo, no gradient, no
  `backdrop-blur`. API-health pill uses re-skinned `Badge`.
- Theme follow-system: `<html>` picks up `prefers-color-scheme`,
  user toggle override persists in localStorage (existing
  `theme-provider.tsx` behavior — unchanged).

## Definition of done

- Token rewrite in `apps/web/src/styles.css` matches §1–§3.
- New `accent` button variant + `attention` runway status exist
  and are used at the documented sites.
- Header, sidebar, and overlay surfaces no longer use
  `backdrop-blur`.
- All UI primitives in `apps/web/src/components/ui/` re-skinned to
  flat + border + new radii. No `--shadow-card` references remain.
- Snapshot tests updated; typecheck, lint, unit, and e2e all green.
- Visual verification at 1440 × 900 and 390 × 844 in both themes
  shows: flat surfaces, monospace numerals on KPIs, honey only on
  headline metric / focused chart series / active nav / primary
  CTAs, no gradients anywhere.
