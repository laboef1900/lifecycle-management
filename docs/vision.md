# Vision — laboef1900/LCM

## Problem

The team had no structured way to track vSphere memory capacity forecasts — before last week, it was pure chaos. A manually maintained Excel file was introduced as a first step, but it breaks down the moment multiple people need to contribute: adding a new cluster, host, or memory-consuming application requires understanding fragile formulas and row structures. The tool replaces the Excel entirely and becomes the single source of truth for capacity planning.

## Users

Approximately 5 concurrent users, all members of the internal infrastructure team responsible for managing vSphere clusters. They need to enter, update, and visualise capacity data without any spreadsheet expertise. The tool is not intended for end-users, application owners, or external stakeholders in v1.

## End-state

A browser-based application where every data point from the current Excel is visible and maintainable: per-cluster memory usage over time, hardware limits, quarterly consumption growth, and event annotations (e.g. OpenShift rollouts, HPE server expansions). Adding a new cluster, a new host (RAM resource), or a new memory-consuming application takes seconds via intuitive forms. The forecast timeline and event markers are rendered as clear, readable charts. The tool is the authoritative record — no Excel import or sync is needed.

## Tech Stack

Full TypeScript stack for end-to-end type safety. **Backend:** Node.js + Fastify for a lightweight, performant REST API. **Frontend:** React + TypeScript + Recharts for time-series and bar chart visualisations. **ORM:** Prisma for type-safe, migration-driven PostgreSQL access. **Containerisation:** Docker Compose orchestrating three services — Fastify API, React app served via Nginx, and a dedicated PostgreSQL container. The data model must be designed **resource-metric-agnostic** from day one — abstracting the metric type (memory, CPU, disk) so that adding new metric dimensions in future requires schema extension, not a redesign.

## Runtime Target

Self-hosted via Docker Compose on an internal Linux server. Three containers: backend API (Fastify), frontend static build (Nginx), and PostgreSQL database. The architecture must be designed with future multi-tenancy in mind (SaaS evolution), so tenant isolation concerns should be considered in the data model from day one even if not enforced in v1.

## Non-goals

The following were explicitly out of scope **for v1**: live vSphere API integration (all data is entered manually), CPU and storage capacity tracking (memory only), authentication and OIDC (deferred to the 3-month milestone), Excel import/export or any synchronisation with spreadsheets, mobile-optimised layout, and alerting or threshold notifications.

> **Amendment (2026-07-17) — v1 has shipped, and live vSphere integration is now the active horizon.** Horizons (below) has always named it as the long-term direction; epic [#172](https://github.com/laboef1900/lifecycle-management/issues/172) implements it against the approved design in [`vsphere-integration-design.md`](vsphere-integration-design.md). The v1 non-goal above and the "premature hypervisor API integration" anti-pattern below are **retained as history, not as current constraints** — they existed to stop hypervisor plumbing derailing the v1 data-entry UX, and that risk has passed. **The remaining v1 non-goals still stand:** CPU/storage tracking, Excel sync, mobile layout, and alerting are all still out of scope. OIDC shipped.

## Principles

**Simplicity first** — when two approaches conflict, choose the one that is easier to understand and maintain. **Great UI/UX** — the interface must feel polished and intuitive; friction in data entry is a failure. **Data accuracy** — the tool is the source of truth, so correctness of stored values and forecast calculations is non-negotiable. These three, in order, resolve any design conflict.

## Horizons

**1 month (v1):** All data currently in the Excel spreadsheet is visible and editable in the app — clusters, monthly memory usage, hardware limits, consumption deltas, and event annotations. **3 months:** OIDC/Auth integration so access is controlled and auditable. **Long-term:** Evolution into a multi-tenant SaaS product capable of serving thousands of users across different organisations, with tenant-isolated data, subscription management, and self-service onboarding. Capacity tracking expands beyond memory to include **CPU and disk forecasting**. The manual data entry model is progressively replaced by **live hypervisor integrations** — starting with vSphere, then extending to Proxmox and other platforms — so that current utilisation is pulled automatically and forecasts are built on real-time baselines.

## Forecast modelling semantics

Recorded 2026-07-17 (epic #172 design gate). **This is purchasing-critical arithmetic that was previously implicit in `services/forecast.ts` and written down nowhere.** Two invariants govern how the forecast composes a number, and violating either produces a _plausible wrong answer_ rather than an error.

**1. `baseline*` is the portion NOT modelled by tracked entities.** `computeForecast` treats `baselineConsumption`/`baselineCapacity` as an **offset**, then **adds** each tracked host's capacity and each tracked application's allocation to it. So a baseline that already contains a tracked entity double-counts it. `baseline* = 0` is the _special case_ where tracked entities account for 100% — which is how vSphere-synced clusters are modelled (vCenter supplies authoritative per-host capacity), and is **not** automatically true of manually-maintained clusters, where the baseline legitimately carries capacity that no host row describes.

**2. Deltas are filtered by the anchor; measurements are not.** The forecast anchors on the **newest** baseline and projects forward. Anything that _describes a change_ — applications, and events carrying `consumptionDelta`/`capacityDelta` — must only apply **after** the anchor's capture date (`effectiveDate > capturedAt`), because a delta dated before the anchor is already _inside_ the measurement. Anything that _carries the measurement_ — hosts, `baselineConsumption`, `baselineCapacity` — is never filtered. This is why hosts are exempt: **they are the measurement**, distributed per host rather than collapsed into a scalar.

The mechanism both invariants guard against is the same one: **an advancing anchor absorbs a delta that was legitimately forward-looking when it was written.** A rollout modelled for next quarter becomes historical once a later baseline measures its effect — the model must stop adding it, or the forecast reports capacity the fleet does not have. Filtering happens **at forecast time**, never at write time: a write-time check validates a predicate that the passage of time (and the monthly snapshot job) later falsifies.

Corollary: **the monthly re-anchor is the error-correction mechanism.** Anchored permanently on the first baseline, every modelling error would compound forever with nothing to correct it.

**3. There is no cluster-level baseline date.** Recorded 2026-07-19 (#195, contract migration). A baseline belongs to one metric and one period; `clusters.baseline_date` — a single operator-declared date shared by every metric — is gone. `ClusterResponse.baselineDate` is now **derived** as the MIN over the newest `capturedAt` per metric, i.e. **the cluster's stalest tracked metric**, and that is what the >90-day staleness flag measures. MIN rather than MAX, because the question a staleness indicator answers is "is any part of this cluster unmeasured?" — the vSphere snapshot job writes `memory_gb` only, so reporting the freshest metric would render a cluster whose cpu anchor has sat frozen for a year as up to date. The field's name and type are unchanged, so nothing forces a consumer to notice the shift; and since every writer snaps `capturedAt` to the first of its month, the derived value can read up to 30 days earlier than the column did. A cluster with no history at all falls back to its `createdAt`, never to today.

**Units:** the `memory_gb` metric stores **GiB (2³⁰)**, despite the `GB` label — matching vCenter, which uses base-2 arithmetic with SI prefixes throughout (govmomi's `units` package defines `GB` as `1 << 30`; `govc cluster.usage` converts `quickStats` "MB" with `<< 20`). The label is a known mislabel, retained because the numbers agree with what the vSphere UI shows and with every baseline entered by hand. **Do not "fix" it to 10⁹** — that would silently shift every forecast by 7.4% and defer hardware purchases that are actually needed.

## Anti-patterns

The tool becomes as cumbersome to use as the Excel it replaced — complex forms, hidden dependencies, or confusing navigation. Charts are cluttered or misleading, causing people to distrust the data and revert to spreadsheets. Data entry for a new host or application takes more than a few clicks. ~~**Premature hypervisor API integration** is attempted in v1, over-complicating the data entry UX that matters most right now — live integrations are a long-term goal, not a v1 concern.~~ _(Retired 2026-07-17: v1 has shipped and vSphere integration is the active horizon — see the Non-goals amendment. The concern it encoded — hypervisor plumbing derailing data-entry UX — is spent.)_ The codebase accumulates premature SaaS features that complicate the v1 experience. Any situation where team members maintain a parallel Excel 'just to be safe' is a clear failure signal.

**A forecast that is confidently wrong is worse than one that admits it doesn't know.** Zero capacity rendered as "0% utilised, healthy"; a missed month interpolated into a smooth line; a synced value silently disagreeing with a hand-entered one — each reads as a reassuring fact and is why this tool would lose the team's trust. Where the honest answer is "unknown" or "gap", say so.

## References

- [`Capacity_Forecast_vSphere.xlsx`](Capacity_Forecast_vSphere.xlsx) — the
  original spreadsheet this tool replaces; also consumed by the
  `db:import-xlsx` script as the seed of historical events.
