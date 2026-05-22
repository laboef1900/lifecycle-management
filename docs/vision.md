# Vision — laboef1900/LCM

*Last refined: 2026-05-21T13:30:16.629386+00:00 via Claude Station*

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

The following are explicitly out of scope for v1: live vSphere API integration (all data is entered manually), CPU and storage capacity tracking (memory only), authentication and OIDC (deferred to the 3-month milestone), Excel import/export or any synchronisation with spreadsheets, mobile-optimised layout, and alerting or threshold notifications.

## Principles

**Simplicity first** — when two approaches conflict, choose the one that is easier to understand and maintain. **Great UI/UX** — the interface must feel polished and intuitive; friction in data entry is a failure. **Data accuracy** — the tool is the source of truth, so correctness of stored values and forecast calculations is non-negotiable. These three, in order, resolve any design conflict.

## Horizons

**1 month (v1):** All data currently in the Excel spreadsheet is visible and editable in the app — clusters, monthly memory usage, hardware limits, consumption deltas, and event annotations. **3 months:** OIDC/Auth integration so access is controlled and auditable. **Long-term:** Evolution into a multi-tenant SaaS product capable of serving thousands of users across different organisations, with tenant-isolated data, subscription management, and self-service onboarding. Capacity tracking expands beyond memory to include **CPU and disk forecasting**. The manual data entry model is progressively replaced by **live hypervisor integrations** — starting with vSphere, then extending to Proxmox and other platforms — so that current utilisation is pulled automatically and forecasts are built on real-time baselines.

## Anti-patterns

The tool becomes as cumbersome to use as the Excel it replaced — complex forms, hidden dependencies, or confusing navigation. Charts are cluttered or misleading, causing people to distrust the data and revert to spreadsheets. Data entry for a new host or application takes more than a few clicks. **Premature hypervisor API integration** is attempted in v1, over-complicating the data entry UX that matters most right now — live integrations are a long-term goal, not a v1 concern. The codebase accumulates premature SaaS features that complicate the v1 experience. Any situation where team members maintain a parallel Excel 'just to be safe' is a clear failure signal.

## References

Reference files for this vision are in [`vision-refs/`](vision-refs/):

- [`Capacity_Forecast_vSphere.xlsx`](vision-refs/Capacity_Forecast_vSphere.xlsx) — 18 KB
