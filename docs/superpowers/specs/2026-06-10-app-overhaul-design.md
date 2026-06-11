# App Overhaul — Design Spec

**Date:** 2026-06-10
**Status:** Approved pending final review
**Scope:** One combined effort: visual/UX overhaul ("Refined Premium"), code-health pass, and four new features (lifecycle timeline, saved scenarios, export & reporting, SMTP breach alerts). Landed as a sequence of focused PRs (see Rollout).

## Goals

- Lift the UI from "clean but conservative" to a premium, modern product feel (reference: Linear/Vercel-grade polish) while keeping the existing identity (IBM Plex, gold accent).
- Fix verified code issues and close test gaps in critical forecast logic.
- Ship four features: fleet lifecycle timeline, saved what-if scenarios, export & reporting, breach-alert emails.

## Decisions log

| Decision             | Choice                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Scope structure      | One combined spec, phased foundation-first execution                                                                                 |
| Visual direction     | B — Refined Premium, **pure in both light and dark** (no ops-glow dark mode)                                                         |
| Accent               | Evolved gold: `#a16207` light / `#fbbf24` dark; gradient logo mark                                                                   |
| Dependencies         | Pragmatic additions: `motion@^12`, `radix-ui@^1.5` (monolithic), `sonner@^2`, `html-to-image`; server: `nodemailer@^8`, `croner@^10` |
| Recharts             | Bump 2 → 3 in Phase 0 (React-19-clean; charts get restyled in Phase 1 anyway)                                                        |
| Prisma 7             | **Out of scope** (ESM-only + driver adapters = separate project)                                                                     |
| Timeline rendering   | Hand-rolled CSS grid, no Gantt library                                                                                               |
| Timeline rows        | Grouped by cluster, collapsible, runway pill per group                                                                               |
| Scenario persistence | Prisma `Json` column validated by shared Zod schema on write **and** read                                                            |
| Alerts delivery      | SMTP email digests (nodemailer); no webhooks for now                                                                                 |
| CSV export           | Hand-rolled RFC-4180 util, no dependency                                                                                             |
| PDF report           | Print-styled routes + browser print-to-PDF; no server-side PDF stack                                                                 |

Mockups (local, gitignored): `.superpowers/brainstorm/*/content/{visual-direction,design-system,timeline-layout}.html`.

## Phase 0 — Code health

Verified findings to fix (each re-confirmed before changing code):

1. `apps/server/src/services/scenario.ts` — replace the 30-day-month delay approximation (`AVG_DAYS_PER_MONTH = 30`) with real UTC month arithmetic consistent with `lib/dates.ts`.
2. `apps/server/src/plugins/error-handler.ts` — narrow service errors via `instanceof` instead of duck-typed `statusCode`/`code` reads; introduce a central error-code registry in `@lcm/shared` (replaces per-service string constants).
3. `apps/web/src/lib/collect-forecast-state.ts` — guard on `isError` explicitly, not on `error != null`.
4. `apps/web/src/routes/index.tsx` — handle clusters with an empty `metrics` array instead of assuming `metrics[0]`.
5. Reproduce, then fix if real: stale baseline series when toggling scenario forecasts on cluster detail (query-key/invalidation check).
6. Charts: `role="img"` + `aria-label` on forecast/tile charts (fuller a11y arrives with Radix in Phase 1).
7. Consolidate date/month formatting helpers (`apps/server/src/lib/dates.ts`, `apps/web/src/lib/format.ts`, `apps/web/src/lib/format-month.ts`) into `@lcm/shared`.
8. Dependency bump: `recharts@^3.8` + migration (no `Customized`/internal-props usage expected; verify).

New tests (close the gaps that made the audit's false-positive plausible):

- Forecast: cumulative event deltas across a multi-month window (event applies once per month from its effective month onward).
- Forecast: multi-metric cluster — each metric's series independent.
- Scenario: delay-procurement combined with events (no capacity invented in the past).

**Explicit non-finding:** the audit's claimed "event accumulation" bug in `forecast.ts:132-136` was refuted — `capacity`/`consumption` reset from baseline each month iteration; semantics are correct.

## Phase 1 — Design system & app shell

### Tokens (`apps/web/src/styles.css`)

- **Neutrals:** warm stone scale. Light: bg `#fafaf9`, surface `#ffffff`, sidebar `#fcfcfb`, border `#eeedec` (hairline) / `#e7e5e4` (strong), fg `#1c1917`, muted `#78716c`, subtle `#a8a29e`. Dark: bg `#171514`, surface `#1f1d1b`, border `#2c2926`, fg `#fafaf9`.
- **Accent:** gold `#a16207` (light) / `#fbbf24` (dark); soft variant via `color-mix`; gradient mark `#a16207 → #854d0e`.
- **Status:** keep semantic hues (green/amber/red), rendered as soft-halo dots (`box-shadow: 0 0 0 3px <color>/12%`) and tinted pills instead of solid badges.
- **Elevation:** layered shadows — resting `0 1px 2px rgba(0,0,0,.04), 0 4px 12px rgba(0,0,0,.025)`; overlay `0 2px 4px rgba(0,0,0,.04), 0 12px 32px rgba(0,0,0,.10)`.
- **Radii:** controls 8px, cards 12px, modals 16px, pills 999px.
- **Type:** IBM Plex Sans/Mono kept; display 26→28px with tighter tracking; `font-variant-numeric: tabular-nums` on every metric; eyebrow labels unchanged.

### Component kit (`apps/web/src/components/ui/`)

- Rebuild on `radix-ui` primitives, keeping current component APIs where possible: Dialog, DropdownMenu (new), Popover (new), Tooltip, Tabs, Select. `Tooltip.Provider` at app root.
- Toaster already wraps `sonner` 1.x — bump to `sonner@^2` and theme it via CSS vars (wording corrected 2026-06-11; the original line assumed a hand-rolled toaster).
- New primitives: `Skeleton` (shimmer), `EmptyState`, `StatusDot`, `Sparkline`, `AnimatedNumber`, `SegmentedControl`. (`ProgressRing` deviation, decided in the PR 2 plan: `utilization-gauge` is restyled in place and keeps its name until a second consumer needs a generic ring.)

### Motion

- `motion@^12` via `LazyMotion` + `motion/react-m`, `domAnimation` feature set (~20 kB total; upgrade to `domMax` only if card layout animations earn it).
- `MotionConfig reducedMotion="user"` app-wide; CSS fallback already present.
- Patterns: 150–250 ms ease-out hover/press; KPI counter animation (MotionValue + `useSpring`); staggered card entrance (~30 ms stagger); `AnimatePresence` for dialog/sheet exit.

### App shell

- Header: 48px, frosted (`backdrop-blur` + translucent bg) when scrolled, breadcrumbs inline, search pill with `⌘K`, theme toggle.
- Sidebar: grouped nav (Monitor: Fleet, Clusters, Timeline · Manage: Settings), active item = soft gold pill with inset ring, `NEW` badge slot, collapsible on desktop.
- Page-header pattern everywhere: eyebrow → title → meta line → right-aligned actions.

## Phase 2 — Screen overhauls

- **Fleet overview:** rebuilt KPI tiles (animated value, trend delta vs previous month, micro-sparkline, status halo dot); header meta + actions (`Export ↓`, `+ New cluster`); cluster tiles with hover lift, runway pill, threshold line, order-by marker; heatmap with rounded cells + tooltips; shimmer skeletons mirroring final layout; illustrated empty state.
- **Cluster detail:** same KPI treatment; scenario-active state = amber ring + "Scenario" chip across strip and chart; chart restyle (gradient area, warn/crit shaded bands, order-by marker, redesigned tooltip card); `SegmentedControl` window selector; Radix Tabs with animated indicator; sticky table headers + row hover actions in Hosts/Items tabs; dialogs rebuilt on Radix Dialog; scenario controls in a collapsible panel (hosts saved scenarios in Phase 3).
- **Clusters index:** table polish, sortable-header affordances, page-header pattern.
- **Settings:** sectioned cards — Thresholds, Categories, **Alerts** (new; see Phase 3.4).
- **Global:** sonner toasts for mutations, restyled command palette, designed 404/error routes, consistent confirm dialogs, refreshed favicon/logo.

## Phase 3 — Features

### 3.1 Fleet lifecycle timeline (`/timeline`)

- **Server:** `GET /api/timeline` → per cluster: hosts (`commissionedAt`, `decommissionedAt`, `projectedDecommissionAt`), order-by dates (procurement service), planned replacements (host-replacements). Tenant-scoped like all routes.
- **Web:** CSS-grid Gantt — one column per month over the window (12/24/36 via SegmentedControl); rows grouped by cluster (collapsible, runway pill on the group header); bar = in-service span, hatched tail = projected wind-down, red diamond = order-by deadline, dashed outline = planned replacement; gold "today" line; Radix tooltip per element; row click → cluster detail. Unit-test the date→column math.

### 3.2 Saved what-if scenarios

- **Prisma:** `Scenario { id, tenantId, clusterId, name, params Json, createdAt, updatedAt }`, unique `(tenantId, clusterId, name)`, cascade on cluster delete.
- **Validation:** reuse the shared scenario Zod schema for `params` on write **and** on read (`safeParse`; corrupt rows surface as 422, never crash).
- **API:** `GET/POST/PATCH/DELETE /api/clusters/:id/scenarios`.
- **Web:** scenario panel lists saved scenarios; "Save as…" persists current controls; applying overlays the scenario series alongside baseline in the chart (replaces today's swap-out behavior); rename/delete via DropdownMenu.

### 3.3 Export & reporting

- **PNG:** `html-to-image` `toPng(chartNode, { pixelRatio: 2 })` (embeds the self-hosted IBM Plex webfonts automatically).
- **CSV:** shared ~15-line RFC-4180 util (quote `",\n`, CRLF, UTF-8 BOM) + Blob download. Exports: forecast months (cluster), fleet summary (overview).
- **Report:** print-styled routes — `/clusters/$id/report` and `/report` (fleet). Tailwind `print:` variants, `@page` margins, `break-inside: avoid` on cards, fixed-size charts (no `ResponsiveContainer`), `print-color-adjust: exact`. Users print to PDF.

### 3.4 Breach alerts (SMTP digests)

- **Stack:** `nodemailer@^8` non-pooled transport, `transporter.verify()` at boot (log + disable alerts on failure, never crash); `croner@^10` job (TZ-aware, overrun-protected), schedule via `ALERTS_CRON` env (default `0 6 * * *` UTC). Fastify plugin: start in `onReady`, stop in `onClose`.
- **Evaluation:** per tenant — clusters breaching warn/crit now or within the forecast window, plus order-by deadlines entering their lead window. One digest email per tenant per day listing all findings.
- **Idempotency:** `AlertDigest { tenantId, sentOn (date) }` marker, unique `(tenantId, sentOn)`; boot-time catch-up runs if today's digest is missing; duplicate sends impossible.
- **Config:** env `SMTP_HOST/SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASS/SMTP_FROM`; per-tenant settings (recipients list, enabled flag) in Settings → Alerts UI, stored with existing tenant settings.
- **Email:** plain HTML table digest, no template engine.

## Error handling

- Web mutations: typed API errors surfaced as sonner toasts; queries keep inline error cards.
- Server: error handler narrows custom errors via `instanceof`; shared error-code registry.
- Alert job: failures are logged and retried at the next tick; SMTP outage degrades to a log warning.

## Testing

- Per-component vitest tests follow existing conventions for every rebuilt/new component.
- Timeline: unit tests for date→grid-column mapping (window edges, mid-month dates, decommission before window).
- Scenarios: service + route tests (CRUD, validation, tenant isolation); web tests for save/apply/overlay.
- Alerts: service tests with stub transport (nodemailer JSON transport); digest idempotency (marker present → skip); cron never starts when `NODE_ENV=test`.
- Phase 0 adds the three forecast/scenario tests listed above.
- Playwright golden path grows: timeline renders bars; CSV download produces a file; scenario save + apply shows overlay.
- Every PR: `pnpm lint`, `pnpm typecheck`, `pnpm test` green in CI.

## Rollout (sequence of focused PRs)

1. Phase 0 fixes + new tests (+ recharts 3 bump)
2. Tokens + new deps + ui-kit rebuild (visual change is global but mechanical)
3. App shell + fleet overview
4. Cluster detail + clusters index + settings restyle
5. Timeline (server route + page)
6. Saved scenarios (migration + API + panel)
7. Export & reporting
8. Alerts (migration + plugin + Settings UI)
9. Docs: README, vision, fresh screenshots

## Out of scope

- Prisma 7 upgrade; auth (separate milestone per vision doc); webhook/Slack alert channels; server-side PDF generation; dev-DB Postgres 18 parity.
