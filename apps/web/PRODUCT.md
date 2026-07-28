# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

~5 concurrent users, all members of one internal infrastructure team that manages
the organisation's vSphere clusters. Two roles: **ADMIN** (enters and maintains
capacity data) and **VIEWER** (reads forecasts). They need to enter, update, and read
capacity data with no spreadsheet expertise. The product's centre of gravity is
**reading the forecast to make hardware-purchasing decisions** — the data-entry and
vSphere-sync work exists to keep that read trustworthy. Not intended for application
owners, end-users, or external stakeholders in v1.

## Product Purpose

A self-hosted, browser-based capacity-forecasting tool for vSphere memory, and the
single source of truth for capacity planning. It replaces a fragile hand-maintained
Excel workbook that broke down the moment more than one person had to contribute
(adding a cluster, host, or application meant understanding brittle formulas and row
structures). Every data point from that spreadsheet — per-cluster memory usage over
time, hardware limits, quarterly consumption growth, and event annotations — is visible
and maintainable through intuitive forms and rendered as clear time-series charts.
Success is the team trusting the app enough that no one keeps a parallel spreadsheet
"just to be safe."

## Positioning

The forecast is purchasing-critical arithmetic computed as a **pure function over
baselines, hosts, applications, and events** — not a dashboard of pre-stored numbers.
Its defining stance is honesty: **a forecast that is confidently wrong is worse than one
that admits it doesn't know.** Zero capacity is never rendered as "0% utilised,
healthy"; a missing month is never interpolated into a smooth line; a vSphere-synced
value that disagrees with a hand-entered one is never silently reconciled. Where the
honest answer is "unknown" or "gap", the product says so. That honesty — and being the
authoritative record rather than a copy that drifts — is what a spreadsheet cannot do
and what earns the team's trust.

## Operating Context

- Self-hosted via Docker Compose on an internal Linux server; internal-network only,
  no public exposure. Plain HTTP is a supported deployment (HSTS deliberately off).
- ADMINs add clusters, hosts (RAM resources), and memory-consuming applications through
  forms, and annotate events (e.g. OpenShift rollouts, HPE server expansions); VIEWERs
  read the resulting forecast.
- vSphere/vCenter integration is live: LCM **reads** per-host capacity from vCenter and
  **never writes to it**. TLS trust is leaf-fingerprint-pinned and fails closed; sync is
  unattended and read-only.
- The forecast re-anchors monthly (a snapshot job), and that re-anchor is the model's
  error-correction mechanism — so the tool is used continuously over time, not in a
  single sitting.

## Capabilities and Constraints

- **Metrics:** memory only in v1. The data model is deliberately
  **resource-metric-agnostic** — adding CPU or disk is a schema extension, not a
  redesign. _(Durable constraint, confirmed by owner 2026-07-23.)_
- **Tenancy:** single-tenant in v1 (every authenticated user sees the same shared data;
  roles gate mutations). The model was built **tenant-isolation-in-mind** for a future
  multi-tenant SaaS evolution — future work must not regress that.
  _(Durable constraint, confirmed by owner 2026-07-23.)_
- **Auth:** three modes — `disabled` (default, trusted-network), `local` (argon2id
  accounts), and `oidc`. RBAC is ADMIN/VIEWER; all mutations require ADMIN.
- **Units landmine:** the `memory_gb` metric stores **GiB (2³⁰)** despite the `GB`
  label, matching vCenter's base-2 arithmetic. This is a deliberate, known mislabel —
  do **not** "fix" it to 10⁹; doing so silently shifts every forecast by 7.4% and defers
  hardware purchases that are actually needed.
- **Forecast semantics** are purchasing-critical and specified in `docs/vision.md`
  §"Forecast modelling semantics": `baseline*` is an offset that tracked hosts/apps add
  to; deltas are filtered by the anchor while measurements are not; there is no
  cluster-level baseline date (it is _derived_ as the MIN over the newest per-metric
  captures — the cluster's stalest metric); host→cluster membership is time-scoped.
  Design must never contradict these numbers.
- **Standing v1 non-goals:** CPU/storage tracking, Excel import/export or any
  spreadsheet sync, mobile-optimised layout, and alerting/threshold notifications are
  all out of scope.

## Brand Commitments

- **Name:** **LCM** (Lifecycle Management) is the durable product/brand name;
  **"Capacity Forecast"** is its current functional descriptor. The app title lockup is
  "Capacity Forecast — LCM". _(Owner was undecided 2026-07-23 and asked for a
  recommendation: keep LCM as the brand because it stays accurate as scope grows to
  CPU/disk and broader infrastructure lifecycle, and lead surfaces with the "Capacity
  Forecast" descriptor for what the tool does today. Revisable.)_
- **Existing assets:** the hexagon-wave brand mark — `src/components/ui/brand-mark.tsx`,
  `src/assets/logo-light.svg`, `src/assets/logo-dark.svg`, `public/favicon.svg`.
- **Voice:** precise, factual, and reassuring about limits — it states plainly what it
  does and does not do (e.g. "LCM reads capacity from vCenter and never writes to it";
  "Compare the fingerprint against your vCenter before you confirm"). No hype.
- **Design system:** "Mission Bento" (shipped 2026-07; **cool-brand** revision
  2026-07-23) — dark-primary UI, **steel-led brand + interaction accent** with amber
  reserved for utilization/attention, self-hosted Space Grotesk / Inter /
  JetBrains Mono, linear `BulletMeter`s rather than radial gauges. Tokens live in
  `apps/web/src/styles.css` (Tailwind v4 CSS-first `@theme`; no `tailwind.config`). Full
  spec in `CLAUDE.md` and
  `docs/superpowers/specs/2026-07-16-mission-bento-ui-design.md`.

## Evidence on Hand

- `docs/Capacity_Forecast_vSphere.xlsx` — the original spreadsheet this tool replaces;
  also consumed by the `db:import-xlsx` script as the seed of historical events.
- Authoritative product docs: `docs/vision.md`, `docs/operations.md`,
  `docs/CONTRIBUTING.md`.
- Real internal infrastructure inventory and capacity data (clusters, hosts,
  applications, events) plus live vSphere connections.
- **No** customer testimonials, external case studies, press, pricing, or public
  benchmarks exist — this is an internal tool. Future work must not fabricate them.

## Product Principles

Ordered; when two conflict, the earlier wins (from `docs/vision.md`):

1. **Simplicity first** — choose the approach that is easier to understand and maintain.
2. **Great UI/UX** — the interface must feel polished and intuitive; friction in data
   entry is a failure.
3. **Data accuracy** — the tool is the source of truth, so correctness of stored values
   and forecast calculations is non-negotiable.
4. **Honest uncertainty** — say "unknown" or "gap" rather than present a
   confidently-wrong number.

## Accessibility & Inclusion

Target **WCAG 2.2 Level AA**. Colour must never be the only signal for status or
required action (pair it with text, icons, or patterns); keyboard-operable controls,
visible focus, sufficient contrast, and reduced-motion support are required across
**both** the light and dark themes.
