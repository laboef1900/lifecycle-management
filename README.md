<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logos/logo-dark.svg">
    <img src="docs/logos/logo-light.svg" alt="LCM logo" width="120" height="120">
  </picture>
</p>

<h1 align="center">LCM — vSphere memory capacity forecasting</h1>

<p align="center">
  Replace the capacity spreadsheet with a browser-based app that is the single
  source of truth for vSphere memory capacity planning.<br>
  Built for a small internal infrastructure team; self-hosted via Docker Compose.
</p>

See [`docs/vision.md`](docs/vision.md) for the full product context.

## Architecture

A pnpm monorepo with three runtime services:

- **`apps/server`** — Fastify + Prisma on Node 26. Exposes a typed REST API
  rooted at `/api`, plus `/healthz` / `/readyz`. Computes the forecast as a
  pure function over baselines, hosts, applications, and events.
- **`apps/web`** — Vite + React 19 + TanStack Router/Query + Recharts +
  Tailwind v4. SPA served by Nginx in production.
- **`packages/shared`** — Zod schemas + inferred TS types consumed by both
  the server (route validation) and the web app (forms + response types).
- **Postgres 18** holds the lone source of truth. Schema-only multi-tenancy
  (`tenant_id` columns everywhere). OIDC authentication is available, off by
  default — see [`docs/operations.md`](docs/operations.md).

## Prerequisites

- **Node.js 26** and **pnpm 11** (the repo pins `packageManager`)
- **Docker** with Compose (development uses just Postgres; production uses
  all three services)

## Run locally for development

```bash
# 1. install
pnpm install

# 2. bring up the dev DB (Postgres 18 with a named volume)
pnpm db:dev:up

# 3. apply migrations and seed the four reference clusters
pnpm --filter @lcm/server exec prisma migrate deploy
pnpm seed

# 4. (optional) import the events the reference spreadsheet records,
#    giving every cluster a realistic 18-month forecast
pnpm --filter @lcm/server db:import-xlsx

# 5. start server (port 8090) and web (port 5173) in watch mode
pnpm dev
```

Open <http://localhost:5173>. The Vite dev server proxies `/api/*`,
`/healthz`, and `/readyz` to the server.

> The server listens on **8090** in dev (not 8080) to avoid colliding with
> common local services. Adjust via `apps/server/.env` if needed.

## Run the production stack

```bash
cp docker/.env.example docker/.env
# edit docker/.env — at least set POSTGRES_PASSWORD

docker compose -f docker/docker-compose.yml --env-file docker/.env pull
SEED_ON_BOOT=true docker compose -f docker/docker-compose.yml --env-file docker/.env up -d
# first boot: server applies migrations + seeds reference clusters
```

`docker/.env` configures the stack environment for `docker/docker-compose.yml`.
Run commands from the repo root or inside `docker/`.

The compose file pulls `lcm-server` and `lcm-web` from GHCR; set
`LCM_IMAGE_TAG=0.5` in `docker/.env` to pin a release instead of `:latest`.

The web container listens on `${HTTP_PORT:-80}` and serves both the SPA and a
reverse proxy to the server at `/api/*`. After the first successful boot,
flip `SEED_ON_BOOT` back to `false` (or unset it) so subsequent restarts
skip the seed.

Full deploy / backup / upgrade notes: [`docs/operations.md`](docs/operations.md).

## Production container images

All three containers run on [Docker Hardened Images](https://www.docker.com/products/hardened-images/) — minimal, distroless variants that ship only what each service needs to run. The two `lcm-*` images are built and pushed by `.github/workflows/publish-images.yml` on push to `main` / `dev` / a release tag.

| Container | Image                                  | Size    | Notes                                                                                                                             |
| --------- | -------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `db`      | `dhi.io/postgres:18`                   | 1.14 GB | Hardened Postgres 18. `PGDATA=/var/lib/postgresql/18/data` (versioned path — the named volume mounts there).                      |
| `server`  | `ghcr.io/laboef1900/lcm-server:latest` | 604 MB  | Distroless Node 26 runtime; multi-stage build, Node entrypoint replaces a shell script. Was 1.6 GB on the unhardened base (-62%). |
| `web`     | `ghcr.io/laboef1900/lcm-web:latest`    | 70 MB   | Distroless nginx; listens on container-side `:8080` (nonroot can't bind 80). Was 94 MB on `nginx:alpine` (-25%).                  |

> **Dev DB**: `docker/docker-compose.dev.yml` uses the official `postgres:18-alpine` rather than the hardened `dhi.io/postgres:18` — same major, a lighter image for local use. Its volume mounts at `/var/lib/postgresql` (that image sets `PGDATA=/var/lib/postgresql/18/docker`); dev volumes are throwaway, so reset with `pnpm db:dev:reset`. See [`docker/README.md`](docker/README.md).

## Environment variables

| Variable                | Default                                   | Used by                | Purpose                                                                                                         |
| ----------------------- | ----------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | `postgresql://lcm:lcm@localhost:5432/lcm` | server                 | Prisma connection string                                                                                        |
| `PORT`                  | `8080` (prod), `8090` (dev)               | server                 | Server listen port                                                                                              |
| `HOST`                  | `0.0.0.0`                                 | server                 | Server listen host                                                                                              |
| `LOG_LEVEL`             | `info`                                    | server                 | Pino log level (`trace`–`silent`)                                                                               |
| `NODE_ENV`              | `development`                             | server                 | Switches log format + features                                                                                  |
| `CORS_ORIGIN`           | unset (CORS disabled)                     | server                 | Comma-separated allowlist of CORS origins                                                                       |
| `TRUST_PROXY`           | `loopback,uniquelocal`                    | server                 | Trusted proxy ranges for `X-Forwarded-*`                                                                        |
| `RATE_LIMIT_MAX`        | `300`                                     | server                 | Max requests per minute per IP                                                                                  |
| `SEED_ON_BOOT`          | `false`                                   | server (compose)       | Runs `prisma db seed` on container start                                                                        |
| `POSTGRES_USER`         | `lcm`                                     | db (compose)           | Postgres role                                                                                                   |
| `POSTGRES_PASSWORD`     | `— (required)`                            | db + server (compose)  | Postgres password (compose refuses to start if unset)                                                           |
| `POSTGRES_DB`           | `lcm`                                     | db (compose)           | Postgres database name                                                                                          |
| `HTTP_PORT`             | `80`                                      | web (compose)          | Host port mapped to nginx :8080                                                                                 |
| `LCM_IMAGE_TAG`         | `latest`                                  | server + web (compose) | GHCR image tag (e.g. `0.5`, `dev`)                                                                              |
| `CONFIG_ENCRYPTION_KEY` | `— (required)`                            | server (compose)       | Encrypts the DB-backed OIDC config; compose refuses to start if unset — generate with `openssl rand -base64 32` |
| `RECOVERY_DISABLE_AUTH` | `false`                                   | server (compose)       | Break-glass: forces auth off for that boot only, in memory — the stored auth config is left untouched           |

OIDC itself is configured at runtime via **Settings → Authentication**, not
env vars — see [`docs/operations.md`](docs/operations.md#authentication-oidc).
The `AUTH_MODE` / `OIDC_*` vars in `.env.example` are seed-only (first-boot
provisioning); they're ignored on every later boot.

## Day-to-day commands

```bash
pnpm dev            # server + web in watch mode (parallel)
pnpm lint           # ESLint flat config across all workspaces
pnpm typecheck      # tsc --noEmit across all workspaces
pnpm test           # API integration tests (testcontainers) + web unit tests
pnpm build          # vite build for the web bundle
pnpm format         # prettier --write .

# focused targets
pnpm --filter @lcm/server dev
pnpm --filter @lcm/web test
pnpm --filter @lcm/web test:e2e   # Playwright golden-path (needs dev server up)

# one-time data tools — wipe-and-replace events + hosts on the four reference
# clusters from docs/Capacity_Forecast_vSphere.xlsx (or pass a path to override).
# Other clusters are untouched.
pnpm --filter @lcm/server db:import-xlsx [path]
```

## Repository layout

```
.
├─ apps/
│  ├─ server/             Fastify + Prisma (Node 26)
│  └─ web/                React + Vite SPA
├─ packages/
│  └─ shared/             Zod schemas + types (consumed by server + web)
├─ docker/                Dockerfiles, nginx config, entrypoint, compose files
│  ├─ docker-compose.yml      Production stack (db + server + web)
│  └─ docker-compose.dev.yml  Dev DB only
├─ docs/                  Vision, operations runbook, reference spreadsheet
└─ .github/workflows/ci.yml   Lint · typecheck · test · build
```

## Contributing

Short version: branch off `dev` as `feat/<short-slug>`, make a focused commit,
open a PR against `dev` that closes the issue, ensure CI is green. Long
version: [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md).
