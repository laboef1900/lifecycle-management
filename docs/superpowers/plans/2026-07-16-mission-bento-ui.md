# Mission Bento UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the web UI as the approved "Mission Bento" fleet console — one dark-first console (order-by rail, fleet verdict, uniform cluster tiles) with cluster detail as a URL-addressable slide-in panel — with a matching light theme.

**Architecture:** Pure-frontend change in `apps/web` + docs. The token system in `src/styles.css` is swapped wholesale (every `ui/*` primitive inherits); routes `/` and `/clusters` merge into a `FleetConsole` component; `/clusters/$id` renders the console with a `ClusterPanel` overlay so deep links, the command palette, and the 401 redirect keep working. All data comes from existing endpoints (`forecast.procurement.orderByDate`, scenario preview, host lifecycle dates).

**Tech Stack:** React 19, TanStack Router (file-based) + Query 5, Tailwind 4 CSS-first tokens, Radix, Recharts 3, @fontsource, Vitest + RTL, Playwright.

**Companion spec (read first):** `docs/superpowers/specs/2026-07-16-mission-bento-ui-design.md` — token tables (§3), console composition (§4), panel behavior (§5), a11y floor (§6). The visual reference is `docs/mockups/06-mission-bento.html` in the main checkout at `/Users/simon/Documents/localGIT/lifecycle-management/docs/mockups/06-mission-bento.html` (read-only).

## Global Constraints

- Worktree: `/Users/simon/Documents/localGIT/mission-bento-ui`, branch `feat/mission-bento-ui` (off origin/dev). Commits local only — never push, never touch `main`/`dev`.
- After every task: `pnpm lint && pnpm typecheck && pnpm --filter @lcm/web test` green before committing. Baseline: 326 web tests / 54 files pass.
- TypeScript strict; no `any`, no suppressions, no disabled tests. Status never color-alone. Both themes must work for every change after Task 1.
- No new runtime deps beyond `@fontsource/inter`, `@fontsource/space-grotesk`, `@fontsource/jetbrains-mono` (verify on npm before adding; pnpm 11, one root lockfile, no `--force`).
- Existing helpers to reuse, not reimplement: `collectForecastState`, `earliestOrderByFromFleet`, `buildClusterForecastEntries`, `fleetRunwayToWarn`, `runwayToWarn`, `utilStatus`, `deriveProcurementKpi`, `aggregateFleet`, `useEffectiveThresholds`, `useChartColors`, `resolveWindow`, `formatGb`, `formatMonthShort/Long`.
- Commit style: `type(scope): description` (`feat(web): …`, `test(web): …`, `docs: …`).

---

### Task 1: Design tokens, fonts, focus ring, hardcoded-palette remediation

**Files:**

- Modify: `apps/web/src/styles.css` (full token rewrite per spec §3: dark = `html.dark`? **No — dark is now the richer theme but light stays `:root` default with `html.dark` overrides exactly as today; put the light table in `:root`, dark table in `html.dark`.** Add `--steel`, `--font-display`, gradients as `--surface-card`/`--surface-backdrop` custom props, radii 8/14/16, global `:focus-visible` two-layer ring, keep reduced-motion block + shimmer)
- Modify: `apps/web/package.json` (+3 @fontsource deps; remove `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono`)
- Modify: `apps/web/src/lib/use-chart-colors.ts` (FALLBACK_LIGHT/FALLBACK_DARK mirror new `--chart-*` values)
- Modify: `apps/web/src/components/clusters/host-state-badge.tsx` (token variants: ordered/racked → steel-info style `text-[var(--steel)] bg-[color-mix(in_oklab,var(--steel)_12%,transparent)]`; in_service → success soft; degraded → warning soft; decommissioned/disposed → muted), `apps/web/src/components/clusters/host-eol-pill.tsx` (`text-warning` / `text-fg-subtle`), `apps/web/src/components/clusters/hosts-tab.tsx:387` + `apps/web/src/components/clusters/items-tab.tsx:379` (`text-emerald-700` → `text-success`)
- Test: update `host-state-badge.test.tsx` class assertions; all other tests must stay green unchanged.

**Interfaces produced:** tokens `--steel`, `--font-display`, `--surface-card`, `--surface-backdrop`; Tailwind utilities `text-steel`/`bg-steel`/`border-steel` via `@theme` `--color-steel`.

- [ ] Verify packages exist: `npm view @fontsource/inter version && npm view @fontsource/space-grotesk version && npm view @fontsource/jetbrains-mono version`
- [ ] `pnpm --filter @lcm/web add @fontsource/inter @fontsource/space-grotesk @fontsource/jetbrains-mono && pnpm --filter @lcm/web remove @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono`
- [ ] Rewrite `styles.css` per spec §3 (imports: inter 400/500/600/700, space-grotesk 500/600/700, jetbrains-mono 400/500/600/700; keep `@theme` mapping pattern and typography scale names; add `--color-steel`; body font stays `var(--font-sans)`)
- [ ] Update the four hardcoded-palette files + `use-chart-colors.ts` fallbacks
- [ ] Update `host-state-badge.test.tsx` expectations; run `pnpm --filter @lcm/web test`
- [ ] Visual smoke: `pnpm dev` (or vite preview), screenshot `/` and `/clusters/<seeded id>` in light + dark, check readability (agent may use the shared Playwright MCP browser)
- [ ] `pnpm lint && pnpm typecheck` → commit `feat(web): mission-bento design tokens, fonts, and focus system`

### Task 2: Chrome — topbar replaces sidebar/breadcrumbs; palette + shortcuts update

**Files:**

- Modify: `apps/web/src/components/layout/app-shell.tsx` (topbar per spec §4.1: brand Link→`/`, ⌘K trigger, `<Link to="/settings">`, ThemeToggle, UserMenu; remove Sidebar/MobileSidebarSheet/Breadcrumbs/MobileNavTrigger; keep `<main class="relative min-h-0 flex-1 overflow-y-auto">` scroll containment; topbar `<nav aria-label="Primary navigation">` wraps the nav links so e2e keeps a stable landmark)
- Delete: `apps/web/src/components/layout/sidebar.tsx`, `apps/web/src/components/layout/breadcrumbs.tsx`, `apps/web/src/components/layout/mobile-nav.tsx` + `mobile-nav.test.tsx`
- Modify: `apps/web/src/components/command/command-palette.tsx` ("Go to fleet" → `/` hint `g o`; remove "Go to clusters"; keep cluster entries → `/clusters/$id`; keep create-cluster + shortcuts + theme groups), `keyboard-shortcuts.tsx` (remove `g c`), `shortcuts-dialog.tsx` (row copy)
- Test: update `src/__tests__/keyboard-shortcuts.test.tsx` (drop `g c` case, keep `g o`, add regression: `g c` does nothing), `src/__tests__/command-palette.test.tsx` (rename nav item assertions)

**Interfaces produced:** `AppShell` with topbar-only chrome; landmark `nav[aria-label="Primary navigation"]` inside `<header>`.

- [ ] Write failing test updates first (keyboard-shortcuts, command-palette), run to see them fail against old chrome
- [ ] Implement topbar + deletions; fix all imports (`rg "sidebar|breadcrumbs|mobile-nav" apps/web/src`)
- [ ] `pnpm --filter @lcm/web test` → green; `pnpm lint && pnpm typecheck` → commit `feat(web): topbar chrome replaces sidebar and breadcrumbs`

### Task 3: Fleet console (`/` merge)

**Files:**

- Create: `apps/web/src/components/fleet/order-by-rail.tsx`, `fleet-verdict.tsx`, `cluster-tile.tsx`, `cluster-tile-chart.tsx`, `stale-baseline.ts` (+ colocated `.test.tsx` for each)
- Create: `apps/web/src/components/fleet/fleet-console.tsx` (assembles queries + sections; owns `showArchived` state; renders CreateClusterDialog inside AdminOnly)
- Modify: `apps/web/src/routes/_app.index.tsx` → renders `<FleetConsole />`; `apps/web/src/routes/_app.clusters.index.tsx` → `beforeLoad: () => { throw redirect({ to: '/' }) }`; Delete `apps/web/src/routes/_app.clusters.new.tsx`; run `pnpm --filter @lcm/web generate-routes`
- Modify: `apps/web/src/components/clusters/cluster-lifecycle-card.tsx` (post-delete `navigate({ to: '/' })` + test)
- Delete (with their tests): `components/overview/fleet-cluster-grid.tsx`, `fleet-cluster-tile-chart.tsx`, `fleet-utilization-heatmap.tsx`, `kpi-tile.tsx`, `tile-y-domain.test.ts`, `components/clusters/cluster-list-card.tsx`, `cluster-table.tsx`, `components/ui/utilization-gauge.tsx` (bullet meter replaces it), `components/ui/kpi` remnants — grep for imports before deleting each.

**Interfaces:**

- `stale-baseline.ts`: `const STALE_BASELINE_DAYS = 90; function baselineAgeDays(baselineDate: string, today?: Date): number; function isBaselineStale(baselineDate: string, today?: Date): boolean`
- `orderByUrgency(orderByDate: string | null, today?: Date): 'now' | 'soon' | 'planned' | 'none'` (in `order-by-rail.tsx`, exported; now ≤28 d or past, soon ≤90 d — reuse thresholds consistent with `deriveProcurementKpi`)
- `sortClustersByUrgency(entries: { cluster: ClusterResponse; procurement: ProcurementInfo | undefined; runwayMonths: number | null }[]): …` exported from `fleet-console.tsx` for testing
- `<OrderByRail items={{clusterId,name,orderByDate,leadTimeWeeks}[]} linkedId?: string onTickHover?: (id|null)=>void />`; `<ClusterTile entry={…} forecast={…} thresholds={…} linked?: boolean />` navigates via `<Link to="/clusters/$id">`
- `<FleetVerdict summary={FleetSummary} earliest={…} staleCount={number} />`

**Tests (write first, real assertions):** verdict renders urgent sentence with cluster name + date and all-clear sentence when no order-bys; rail renders one tick per non-null order-by, empty-state text otherwise, tick has `aria-label` containing date + relative days and ≥24px hit area class; `sortClustersByUrgency` orders [oracle-like, p2-like, null-orderBy] correctly with nulls last; `isBaselineStale('2026-03-10', new Date('2026-07-16'))` true / fresh false; tile shows "ORDER BY … · IN …" chip, "no order needed" variant, "⚠ BASELINE … D OLD" variant, and links to `/clusters/$id`.

- [ ] Failing tests → implement components (chart per spec §4.4: shared 0–125% y-domain, ReferenceLine warn/crit/100, solid+dashed consumption split via two Lines split at current month, breach ReferenceDot + order-by marker, halo via paint-order in a `<style>` or label class) → green
- [ ] Wire routes, regenerate route tree, delete retired components after `rg` confirms no imports remain
- [ ] `pnpm lint && pnpm typecheck && pnpm --filter @lcm/web test` → commit `feat(web): fleet console merges overview and clusters pages`

### Task 4: Detail slide-in panel + hosts Gantt + scenario ghost

**Files:**

- Create: `apps/web/src/components/detail/cluster-panel.tsx` (fixed right overlay 58vw/min-600px/100vw<1100px, motion per spec §3, Esc + ✕ → `navigate({to:'/'})`, focus trap in / restore out, `role="dialog" aria-modal="false"` + visually-hidden `role="status"` live region announcing open/close/scenario) + `cluster-panel.test.tsx`
- Create: `apps/web/src/components/detail/recommendation-banner.tsx` (+test): input `ProcurementInfo`, verb-first copy per spec §5.2 using `deriveProcurementKpi` status for tone
- Create: `apps/web/src/components/detail/host-lifecycle-gantt.tsx` (+test): props `{ hosts: HostResponse[]; today?: Date }`; pure SVG (no Recharts) shared-axis bars per spec §5.6; exports `ganttDomain(hosts)` for testing
- Modify: `apps/web/src/routes/_app.clusters.$id.tsx` → renders `<FleetConsole />` + `<ClusterPanel clusterId={id} />`; move the existing detail composition (header, kpi-strip, WindowControls+ForecastChart, ScenarioControls, Tabs) into the panel body — reuse, don't rewrite, the existing section components
- Modify: `apps/web/src/components/clusters/hosts-tab.tsx` (date columns → Lifecycle Gantt cell; dates stay in expanded row + aria-label) + `hosts-tab.test.tsx`
- Modify: `apps/web/src/components/clusters/forecast-chart.tsx` (+test): solid/dashed actual-vs-forecast split at current month; when `scenario` present, scenario line becomes primary (solid amber) and baseline consumption renders muted dashed with "was" legend entry; add delta annotation (months between baseline and scenario warn-breach via `runwayToWarn` of both series) rendered under the legend as text — not on-chart — to keep Recharts changes contained; kpi-strip bullet meter replaces UtilizationGauge usage

**Interfaces consumed:** Task 3's `FleetConsole`; existing `ForecastChart` props `{forecast, scenario?, compact}` extended with `scenarioDeltaLabel?: string`.

- [ ] Failing tests: panel opens with focus + Esc navigates `/`; banner copy for overdue/soon/planned/none; `ganttDomain` min/max; hosts-tab renders one gantt cell per host with aria-label containing all three dates; forecast-chart splits at current month (query dashed segment present) and shows "was" entry under scenario
- [ ] Implement; update `command-palette.test.tsx` expectation if needed (cluster entry still `/clusters/$id`)
- [ ] `pnpm lint && pnpm typecheck && pnpm --filter @lcm/web test` → commit `feat(web): cluster detail slide-in panel with gantt and scenario ghost`

### Task 5: E2E rewrite + docs + full verification

**Files:**

- Modify: `apps/web/playwright/support/scroll-containment.ts` (landmark → `header nav[aria-label="Primary navigation"]` + `<main>` scroll assertions), `playwright/golden-path.spec.ts` (fleet console flow: add cluster → tile appears with 20.0% → click tile name link → panel `kpi-strip` → hosts/items dialogs inside panel → legend + theme cycle → cleanup via URL id), `playwright/layout.spec.ts`, `playwright/mobile.spec.ts` (topbar nav, 1-up tiles, panel at 100vw), `playwright/settings.spec.ts` (`/clusters/:id` gotos still valid — panel renders; `/clusters` list assertions → `/` tile assertions; delete asserts `toHaveURL('/')`), `playwright-oidc/layout.spec.ts`
- Modify: `CLAUDE.md` "UI/UX: House Style" section (new palette summary, fonts, radii, steel accent, no sidebar; bullet-meter-not-gauge rule; keep "no color-alone" rule)
- Modify: `docs/vision.md` only if it names the two-page IA (check; update the navigation description if so)

- [ ] Rewrite specs; run `pnpm --filter @lcm/web test:e2e` against the dev stack (`pnpm db:dev:up && pnpm seed && pnpm dev`) — **coordinate: the prod compose stack may be running; dev ports 5173/8090/5432 must be free; if 5432 conflicts, stop and ask the user before touching any container**
- [ ] Full gates: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` (server tests need Docker)
- [ ] Visual pass both themes at 1440/768 widths; fix regressions
- [ ] Commit `test(web): rewrite e2e for fleet console` + `docs: update house style for mission-bento UI`

### Task 6: Final review

- [ ] `git log --oneline origin/dev..HEAD` sanity; self code-review of the diff (`/code-review` skill if available); confirm Definition of Done items from CLAUDE.md; leave branch unpushed and report status + follow-ups to the user.
