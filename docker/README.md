# Production deployment

This directory holds the Docker assets for self-hosted deployment.
`docker-compose.yml` here wires them together; the root `.env.example`
sets `COMPOSE_FILE=docker/docker-compose.yml` so `docker compose ...` from
the repo root finds it without `-f`.

## Quickstart

```sh
cp .env.example .env
# edit .env — at least set POSTGRES_PASSWORD

docker compose pull
SEED_ON_BOOT=true docker compose up -d
# first boot: server applies migrations + seeds reference clusters

# subsequent boots
docker compose up -d
```

The compose file pulls `ghcr.io/laboef1900/lcm-server` and `lcm-web` from
the GitHub container registry; there are no `build:` blocks. Set
`LCM_IMAGE_TAG=0.1` (or `dev`) in `.env` to pin a release / track the dev
channel instead of `:latest`.

The web container listens on `${HTTP_PORT:-80}` and serves both the SPA at
`/` and a reverse proxy to the server at `/api/*`, `/healthz`, `/readyz`.
The server container listens on 8080 inside the compose network only.

All `dhi.io` base images (in both Dockerfiles and this compose file) are
pinned as `tag@sha256:...` to the **multi-arch index digest** — the
top-level `Digest:` from `docker buildx imagetools inspect <ref>`, not a
per-platform manifest. Dependabot bumps the pins weekly — the `docker`
ecosystem covers the Dockerfiles and the `docker-compose` ecosystem covers
the compose files (the `docker` ecosystem does not scan compose files).
dhi.io updates additionally need registry credentials — see the note in
`.github/dependabot.yml`.

The `db` service runs `dhi.io/postgres:18` (Docker Hardened Image).
`PGDATA=/var/lib/postgresql/18/data`, so the named volume `lcm-postgres-18-data`
is mounted there — not at the older `/var/lib/postgresql/data` path that
the official postgres image uses.

## What ships in each image

- `Dockerfile.server`: multi-stage build on Docker Hardened Images. The
  builder stage uses `dhi.io/node:22-alpine-dev` (full shell + apk +
  corepack); the runtime stage uses `dhi.io/node:22-alpine` (distroless:
  only the `node` binary, runs as uid 65532). `pnpm deploy` flattens
  workspace symlinks into a self-contained `/deploy` bundle. The Node
  entrypoint module at `dist/src/entrypoint.js` runs `prisma migrate deploy`
  on every start (idempotent), conditionally runs the seed, then
  `await import('./index.js')` starts the Fastify server. Built and
  published by `.github/workflows/publish-images.yml` on push to
  main/dev/release.
- `Dockerfile.web`: multi-stage build on Docker Hardened Images. The
  builder stage uses `dhi.io/node:22-alpine-dev` and runs `vite build`;
  the runtime stage uses `dhi.io/nginx:1` (distroless: nginx + libs
  only, runs as uid 65532 nonroot, listens on **:8080** — privileged
  ports require root). Compose maps host `${HTTP_PORT:-80}` to the
  container's 8080. No in-container healthcheck (distroless has no
  wget/curl/shell); compose's `depends_on` chain handles startup
  ordering.

## Building locally (for testing un-published changes)

```sh
docker build -f docker/Dockerfile.server -t ghcr.io/laboef1900/lcm-server:latest ..
docker build -f docker/Dockerfile.web    -t ghcr.io/laboef1900/lcm-web:latest    ..
docker compose up -d
```

## Restart behaviour

`prisma migrate deploy` is a no-op once all migrations are applied, so
restarting `server` is cheap. `prisma db seed` only runs when
`SEED_ON_BOOT=true` is set on the server's environment.

## Local dev (no Docker beyond Postgres)

`docker-compose.dev.yml` (also in this directory) brings up just Postgres;
the server and web run on the host via `pnpm dev` so HMR + watch mode work.
Use `pnpm db:dev:up` / `pnpm db:dev:down` as convenience wrappers.
