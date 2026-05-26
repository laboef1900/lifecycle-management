# LCM — vSphere memory capacity forecasting

Replace the spreadsheet that tracks vSphere memory capacity with a browser-based
app that is the single source of truth for capacity planning. Built for a small
internal infrastructure team; self-hosted via Docker Compose.

See [`docs/vision.md`](docs/vision.md) for the full product context.

## Architecture

A pnpm monorepo with three runtime services:

- **`apps/api`** — Fastify + Prisma on Node 22. Exposes a typed REST API
  rooted at `/api`, plus `/healthz` / `/readyz`. Computes the forecast as a
  pure function over baselines, hosts, applications, and events.
- **`apps/web`** — Vite + React 19 + TanStack Router/Query + Recharts +
  Tailwind v4. SPA served by Nginx in production.
- **`packages/shared`** — Zod schemas + inferred TS types consumed by both
  the api (route validation) and the web app (forms + response types).
- **Postgres 16** holds the lone source of truth. Schema-only multi-tenancy
  (`tenant_id` columns everywhere) — auth lands in the 3-month milestone.

## Prerequisites

- **Node.js 22** and **pnpm 11** (the repo pins `packageManager`)
- **Docker** with Compose (development uses just Postgres; production uses
  all three services)

## Run locally for development

```bash
# 1. install
pnpm install

# 2. bring up the dev DB (Postgres 16 with a named volume)
docker compose -f docker-compose.dev.yml up -d db

# 3. apply migrations and seed the four reference clusters
pnpm --filter @lcm/api exec prisma migrate deploy
pnpm seed

# 4. (optional) import the events the reference spreadsheet records,
#    giving every cluster a realistic 18-month forecast
pnpm --filter @lcm/api db:import-xlsx

# 5. start api (port 8090) and web (port 5173) in watch mode
pnpm dev
```

Open <http://localhost:5173>. The Vite dev server proxies `/api/*`,
`/healthz`, and `/readyz` to the api.

> The api listens on **8090** in dev (not 8080) to avoid colliding with
> common local services. Adjust via `apps/api/.env` if needed.

## Run the production stack

```bash
cp .env.example .env
# edit .env — at least set POSTGRES_PASSWORD

docker compose build
SEED_ON_BOOT=true docker compose up -d
# first boot: api applies migrations + seeds reference clusters
```

The web container listens on `${HTTP_PORT:-80}` and serves both the SPA and a
reverse proxy to the api at `/api/*`. After the first successful boot, flip
`SEED_ON_BOOT` back to `false` (or unset it) so subsequent restarts skip the
seed.

Full deploy / backup / upgrade notes: [`docs/operations.md`](docs/operations.md).

## Environment variables

| Variable            | Default                                   | Used by            | Purpose                                  |
| ------------------- | ----------------------------------------- | ------------------ | ---------------------------------------- |
| `DATABASE_URL`      | `postgresql://lcm:lcm@localhost:5432/lcm` | api                | Prisma connection string                 |
| `PORT`              | `8080` (prod), `8090` (dev)               | api                | Server listen port                       |
| `HOST`              | `0.0.0.0`                                 | api                | Server listen host                       |
| `LOG_LEVEL`         | `info`                                    | api                | Pino log level (`trace`–`silent`)        |
| `NODE_ENV`          | `development`                             | api                | Switches log format + features           |
| `SEED_ON_BOOT`      | `false`                                   | api (compose)      | Runs `prisma db seed` on container start |
| `POSTGRES_USER`     | `lcm`                                     | db (compose)       | Postgres role                            |
| `POSTGRES_PASSWORD` | `lcm`                                     | db + api (compose) | Postgres password                        |
| `POSTGRES_DB`       | `lcm`                                     | db (compose)       | Postgres database name                   |
| `HTTP_PORT`         | `80`                                      | web (compose)      | Host port mapped to Nginx 80             |

## Day-to-day commands

```bash
pnpm dev            # api + web in watch mode (parallel)
pnpm lint           # ESLint flat config across all workspaces
pnpm typecheck      # tsc --noEmit across all workspaces
pnpm test           # API integration tests (testcontainers) + web unit tests
pnpm build          # vite build for the web bundle
pnpm format         # prettier --write .

# focused targets
pnpm --filter @lcm/api dev
pnpm --filter @lcm/web test
pnpm --filter @lcm/web test:e2e   # Playwright golden-path (needs dev API up)

# one-time data tools — wipe-and-replace events + hosts on the four reference
# clusters from docs/Capacity_Forecast_vSphere.xlsx (or pass a path to override).
# Other clusters are untouched.
pnpm --filter @lcm/api db:import-xlsx [path]
```

## Repository layout

```
.
├─ apps/
│  ├─ api/                Fastify + Prisma (Node 22)
│  └─ web/                React + Vite SPA
├─ packages/
│  └─ shared/             Zod schemas + types (consumed by api + web)
├─ docker/                Production Dockerfiles, nginx config, entrypoint
├─ docs/                  Vision, operations runbook, reference spreadsheet
├─ docker-compose.yml     Production stack (db + api + web)
├─ docker-compose.dev.yml Dev DB only
└─ .github/workflows/ci.yml   Lint · typecheck · test · build
```

## Contributing

Short version: branch off `main` as `N-short-slug`, make a focused commit,
open a PR that closes the issue, ensure CI is green. Long version:
[`CONTRIBUTING.md`](CONTRIBUTING.md).
