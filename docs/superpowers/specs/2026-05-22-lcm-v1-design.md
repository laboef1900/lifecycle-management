# LCM v1 — Design Spec

*Date: 2026-05-22*
*Source vision: [`docs/vision.md`](../../vision.md)*

## Goal

Replace the manually maintained `Capacity_Forecast_vSphere.xlsx` with a browser-based application that is the single source of truth for vSphere memory capacity planning. v1 covers ~5 concurrent internal users on a self-hosted Docker deployment.

## Clarifications (locked in 2026-05-22)

| Topic | Decision |
|---|---|
| Data model depth | Full entity-relational — Cluster, Host, Application as first-class entities |
| Forecast methodology | Manual deltas only (no auto-projection in v1) |
| Multi-tenancy | Schema-only `tenant_id` column, default `"default"`, no middleware enforcement |
| UI language | English only |
| Entity lifecycle sizing | Resize events on a single entity timeline |
| Cluster baseline | Baseline fields on `Cluster` (no synthetic "legacy" entities) |
| v1 access control | None — internal network trust |

## Architecture

Monorepo with pnpm workspaces, three Docker Compose services.

```
lifecycle-management/
├─ apps/
│  ├─ api/       Fastify + Prisma + Zod  (Node 22, TS strict)
│  └─ web/       React 19 + Vite + Recharts + TanStack Router/Query
├─ packages/
│  └─ shared/    Zod schemas + inferred TS types (consumed by api + web)
├─ docker/
│  ├─ Dockerfile.api
│  └─ Dockerfile.web    Nginx: serves SPA + proxies /api/* to api
├─ docker-compose.yml   api · web · db (Postgres 16)
└─ .env.example
```

Single ingress on the `web` container's port 80. Web serves the SPA at `/` and reverse-proxies `/api/*` to `api:8080`. No CORS required in production (same origin).

## Data model

All tables carry `tenant_id` (default `"default"`). IDs are CUIDs. Dates stored as `date`.

### Lookup
- **`Tenant`** — `id`, `name`. Seeded with one `default` row.
- **`MetricType`** — `id`, `key` (`memory_gb`), `display_name` (`Memory`), `unit` (`GB`). Seeded with `memory_gb`. Adding CPU/disk later = a new row, no schema change.

### Cluster
- **`Cluster`** — `id`, `tenant_id`, `name` (unique per tenant), `description`, `baseline_date`, timestamps.
- **`ClusterMetricBaseline`** — composite PK `(cluster_id, metric_type_id)`, `baseline_consumption`, `baseline_capacity`. Represents the Excel's "Aktuell" + "HW-Limit" starting values.

### Hosts — capacity providers
- **`Host`** — `id`, `tenant_id`, `cluster_id`, `name`, `description`, `commissioned_at`, `decommissioned_at` (nullable).
- **`HostMetricCapacity`** — `id`, `host_id`, `metric_type_id`, `effective_from`, `amount`. Multiple rows = capacity changed over time. Effective amount at any date = most recent row with `effective_from ≤ date`.

### Applications — consumption sources
- **`Application`** — `id`, `tenant_id`, `cluster_id`, `name`, `category` (free string — `openshift`, `database`, …), `description`, `started_at`, `ended_at` (nullable).
- **`ApplicationMetricAllocation`** — same shape as `HostMetricCapacity`: `(application_id, metric_type_id, effective_from, amount)`.

### Events — un-attributed annotations + deltas
- **`Event`** — `id`, `tenant_id`, `cluster_id`, `metric_type_id`, `effective_date`, `category` (`growth` | `hardware_change` | `openshift` | `note`), `title`, `description`, `consumption_delta` (nullable), `capacity_delta` (nullable). Covers "Wachstum Q1" (+750 GB consumption, no specific app yet) and pure annotations (both deltas null).

### Forecast computation (derived, not stored)

For a cluster + metric at month `T`:

```
capacity(T)    = baseline_capacity
               + Σ host capacity rows in effect at T for active hosts at T
               + Σ event.capacity_delta where event.effective_date ≤ T
consumption(T) = baseline_consumption
               + Σ app allocation rows in effect at T for active apps at T
               + Σ event.consumption_delta where event.effective_date ≤ T
utilization(T) = consumption(T) / capacity(T)
```

A host is "active at T" iff `commissioned_at ≤ T AND (decommissioned_at IS NULL OR decommissioned_at > T)`. Same shape for applications with `started_at` / `ended_at`. If an Event later becomes a real Host/App, the user deletes the Event to avoid double-counting — we don't auto-link.

## API surface

JSON in/out, Zod-validated, base path `/api`. Tenant resolved by middleware (defaults to `default`).

| Resource | Endpoint | Notes |
|---|---|---|
| Health | `GET /healthz`, `GET /readyz` | `/readyz` also pings DB |
| Metric types | `GET /api/metric-types` | |
| Clusters | `GET/POST /api/clusters`, `GET/PUT/DELETE /api/clusters/:id` | List includes today's consumption/capacity/utilization |
| Hosts | `GET/POST /api/clusters/:cid/hosts`, `GET/PUT/DELETE /api/hosts/:id` | |
| Host resize | `POST /api/hosts/:id/capacity` | Appends a `HostMetricCapacity` row |
| Applications | `GET/POST /api/clusters/:cid/applications`, `GET/PUT/DELETE /api/applications/:id` | |
| App resize | `POST /api/applications/:id/allocation` | Appends an `ApplicationMetricAllocation` row |
| Events | `GET/POST /api/clusters/:cid/events`, `PUT/DELETE /api/events/:id` | |
| Forecast | `GET /api/clusters/:id/forecast?metric=memory_gb&from=YYYY-MM&to=YYYY-MM` | Default window = `baseline_date` → `+24 months`. Returns monthly array + events + host/app contribution breakdowns. |

Error responses: `{ error: { code, message, details? } }`. Zod validation failures → 400 with field-level details.

## Frontend

Stack: React 19 + Vite + TS strict, TanStack Router, TanStack Query, Recharts, shadcn/ui + Tailwind.

### Routes
- `/` — Dashboard (cluster list)
- `/clusters/new` — Create cluster
- `/clusters/:id` — Cluster detail (chart + tabs: Hosts | Applications | Events)
- `/settings` — Metric types (read-only in v1)

### Dashboard
Sortable table: name · current consumption · current capacity · % utilization (color-coded green <70%, amber 70–90%, red >90%) · 12-month trend sparkline · Open link. **+ Add cluster** action. Empty state with one-click "seed from sample" dev shortcut behind `NODE_ENV=development`.

### Cluster detail
- **Chart (Recharts)** — X-axis monthly from `baseline_date` for 24 months (toggle 12 / 24 / All). Stacked area for consumption (blue), stepped line for capacity (red). Event markers as colored dots on the consumption line with hover tooltips. Secondary panel: % utilization bar per month. Toggle to stack individual host capacity / app allocation contributions.
- **Hosts tab** — table with name · commissioned_at · decommissioned_at · current capacity · expandable resize history. Actions: + Add, edit, decommission, + Resize.
- **Applications tab** — same shape, with `started_at` / `ended_at` / current allocation.
- **Events tab** — date · category badge · title · deltas. + Add, edit, delete.

### Forms
shadcn `Dialog` modals. Zod-validated using schemas from `packages/shared`. Optimistic mutations via TanStack Query — UI updates immediately, rolls back on error. Toast notifications.

### Polish baseline
Loading skeletons, clear empty states with CTA, keyboard-accessible forms with focus management, inline field errors + toast.

## Testing

- **Backend** — Vitest + Testcontainers (real Postgres per run). Unit tests for forecast computation (pure functions over fixtures); integration tests per REST endpoint.
- **Frontend** — Vitest + React Testing Library; MSW for API mocking. One Playwright smoke test of the golden path: create cluster → add host → add app → see chart update.
- **Shared** — round-trip tests in `packages/shared` to keep Zod ↔ TS types aligned.

## Tooling

- TS strict everywhere: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- ESLint flat config + Prettier (shared at repo root).
- Husky pre-commit: `pnpm lint` + `pnpm typecheck` on staged files via lint-staged.
- Root pnpm scripts: `dev` (compose up db, run api + web in watch), `build`, `test`, `seed`.

## Deployment

- `Dockerfile.api` — multi-stage Node 22 alpine, runs `node dist/server.js`.
- `Dockerfile.web` — multi-stage: build Vite bundle, then Nginx serving `/` + proxying `/api/*` to `api:8080`.
- `docker-compose.yml`:
  - `db` — `postgres:16-alpine`, named volume, healthcheck.
  - `api` — depends_on `db` (healthy), env from `.env`. Runs `prisma migrate deploy` on startup; runs `prisma db seed` only when `SEED_ON_BOOT=true`.
  - `web` — depends_on `api`, exposes `80:80`.
- `.env.example` committed; `.env` ignored.

## CI

Single GitHub Actions workflow `ci.yml` on PR + push to `main`: install pnpm with cache, run `lint` · `typecheck` · `test` (with a Postgres service) · `build`. No deploy step in v1 — the team pulls images manually on the internal host.

## Out of scope (v1, deferred)

- Authentication / OIDC (deferred to 3-month milestone)
- CPU and disk metrics (schema-ready, just no UI/seed in v1)
- Live vSphere or other hypervisor integration
- Excel import/export
- Mobile-optimized layout
- Threshold alerting / notifications
- Multi-tenancy enforcement (schema-only, no row-filtering middleware)
- Audit log / change history

## Open risks

- **Forecast computation cost** — for a single cluster over 24 months with ~50 entities and ~30 events, recomputing per request is trivially cheap. If we ever scale to thousands of clusters per tenant we'll need a cache. Not a v1 concern.
- **Event vs entity double-counting** — relies on user discipline to delete an Event once a real Host/App captures the same delta. Mitigated by clear UI labels ("This is a forecast event — convert to entity when known") and a future enhancement to link Events to entities.
