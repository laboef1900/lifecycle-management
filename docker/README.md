# Production deployment

This directory holds the Docker assets for self-hosted deployment.
`docker-compose.yml` here wires them together; the root `.env.example`
sets `COMPOSE_FILE=docker/docker-compose.yml` so `docker compose ...` from
the repo root finds it without `-f`.

## Quickstart

```sh
cp .env.example .env
# edit .env — at least set POSTGRES_PASSWORD

docker compose build
SEED_ON_BOOT=true docker compose up -d
# first boot: api applies migrations + seeds reference clusters

# subsequent boots
docker compose up -d
```

The web container listens on `${HTTP_PORT:-80}` and serves both the SPA at
`/` and a reverse proxy to the api at `/api/*`, `/healthz`, `/readyz`. The
api container listens on 8080 inside the compose network only.

## What ships in each image

- `Dockerfile.api`: Node 22 alpine + pnpm + tini. Entrypoint
  (`api-entrypoint.sh`) runs `prisma migrate deploy` on every start
  (idempotent — already-applied migrations are skipped), conditionally
  runs `prisma db seed`, then execs `tsx src/index.ts` as the long-lived
  Fastify server.
- `Dockerfile.web`: multi-stage build. Stage 1 installs the pnpm workspace
  and runs `vite build`. Stage 2 is `nginx:alpine` serving the static
  bundle with `nginx.conf` here that handles SPA fallback + the API
  reverse proxy.

## Restart behaviour

`prisma migrate deploy` is a no-op once all migrations are applied, so
restarting `api` is cheap. `prisma db seed` only runs when
`SEED_ON_BOOT=true` is set on the api environment.

## Local dev (no Docker beyond Postgres)

`docker-compose.dev.yml` (also in this directory) brings up just Postgres;
the api and web run on the host via `pnpm dev` so HMR + watch mode work.
Use `pnpm db:dev:up` / `pnpm db:dev:down` as convenience wrappers.
