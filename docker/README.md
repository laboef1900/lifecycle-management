# Production deployment

This directory holds the Docker assets for self-hosted deployment.
`docker-compose.yml` here wires them together using configuration from `docker/.env`.

## Quickstart

```sh
cp docker/.env.example docker/.env
# edit docker/.env — at least set POSTGRES_PASSWORD

docker compose -f docker/docker-compose.yml --env-file docker/.env pull
SEED_ON_BOOT=true docker compose -f docker/docker-compose.yml --env-file docker/.env up -d
# first boot: server applies migrations + seeds reference clusters

# subsequent boots
docker compose -f docker/docker-compose.yml --env-file docker/.env up -d
```

The compose file pulls `ghcr.io/laboef1900/lcm-server` and `lcm-web` from
the GitHub container registry; there are no `build:` blocks. Set
`LCM_IMAGE_TAG=0.1` (or `dev`) in `docker/.env` to pin a release / track the dev
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
Use `pnpm db:dev:up` / `pnpm db:dev:down` / `pnpm db:dev:reset` as convenience
wrappers.

The dev DB is the official `postgres:18-alpine` (production uses the hardened
`dhi.io/postgres:18`). Its named volume `lcm-postgres-dev` mounts at the parent
`/var/lib/postgresql`, because that image sets
`PGDATA=/var/lib/postgresql/18/docker` — mounting the older
`/var/lib/postgresql/data` path would leave the cluster in an ephemeral
container layer. Dev data is throwaway: `pnpm db:dev:reset` (`down -v` + `up`)
clears the volume and brings Postgres back up clean; re-migrate and seed
afterwards. Note a plain `pnpm db:dev:down` now **preserves** the named volume,
so reach for `db:dev:reset` when you need a genuinely empty DB. Carrying a
pre-18 dev volume forward is a recreate, not an in-place upgrade.

### Local Keycloak (for testing OIDC login)

`docker-compose.dev.yml` also has a `keycloak` service, gated behind the
`auth` profile so it doesn't start with a plain `pnpm db:dev:up`:

```sh
docker compose -f docker/docker-compose.dev.yml --profile auth up -d
```

This imports `docker/keycloak/lcm-dev-realm.json` — realm `lcm`, client
`lcm-local` (confidential, secret `lcm-local-secret`, redirect URI
`http://localhost:5173/api/auth/callback`), and a test user `dev` / `dev`.
Keycloak listens on `http://localhost:8081`.

Point the server at it in `apps/server/.env`:

```
# dev-only key — do not reuse in production
CONFIG_ENCRYPTION_KEY=rEYzAdycY7kLEq3gPuNr9MdS0lxiX9u7hLz609nvJGc=
AUTH_MODE=oidc
OIDC_ISSUER_URL=http://localhost:8081/realms/lcm
OIDC_CLIENT_ID=lcm-local
OIDC_CLIENT_SECRET=lcm-local-secret
APP_BASE_URL=http://localhost:5173
OIDC_ALLOW_INSECURE=true
```

`CONFIG_ENCRYPTION_KEY` is **required** for the OIDC vars above to seed
anything — without it the server seeds `auth_config` as disabled and
drops the client secret rather than store it unencrypted (fail-safe, see
`docs/operations.md`). The value above is a fixed **dev-only** example (32
random bytes, base64); do not reuse it anywhere real — generate your own
with `openssl rand -base64 32` if you'd rather not share this one.
These vars are consumed once, on first boot against an empty dev DB, to
pre-seed the config; if you've already booted the dev server before, either
reset the dev DB (`pnpm db:dev:reset`, then re-migrate) or just configure
OIDC directly in Settings → Authentication instead of editing `.env`. (A
plain `db:dev:down && db:dev:up` no longer clears `auth_config` — the named
volume now persists, so `db:dev:reset`'s `down -v` is what actually wipes.)

`OIDC_ALLOW_INSECURE=true` is required here because both the dev server and
this Keycloak instance run over plain HTTP — never set it in production.
Restart `pnpm dev`, browse to <http://localhost:5173>, and sign in as
`dev` / `dev`.

## Configuring authentication (OIDC)

Auth is off by default (`AUTH_MODE=disabled` seed value). OIDC is
DB-backed and configured from the running app's **Settings → Authentication**
panel (admin-only once oidc mode is active) — not by editing `docker/.env` and
redeploying. To turn it on in the production stack:

1. Make sure `CONFIG_ENCRYPTION_KEY` is set in `docker/.env` (it's required for
   compose to start at all — see the fail-closed guard in
   `docker-compose.yml`). Without it OIDC can never be enabled: the server
   has nowhere to safely store a client secret.
2. Start the stack (`docker compose -f docker/docker-compose.yml --env-file docker/.env up -d`) and open the app. Go to
   **Settings → Authentication**, fill in the issuer URL, client ID,
   client secret, and app base URL, then save — the server re-tests OIDC
   discovery before it will actually flip the mode to `oidc`, so a save
   that fails the test never leaves you with a broken config.
3. **Verify it actually took effect**:
   ```bash
   curl -si http://<host>/api/clusters | head -1     # must print HTTP/1.1 401
   curl -s  http://<host>/api/auth/me                # must print {"authRequired":true}
   ```
   Any other result means auth is NOT enabled.

The `AUTH_MODE`/`OIDC_*` vars in `docker/.env.example` still exist as a **seed-only**
path for unattended first-boot provisioning (they're read once, only when
`auth_config` has no row yet); once a row exists, editing them and
restarting has no effect. See
[`docs/operations.md`](../docs/operations.md) ("Authentication (OIDC)") for
IdP registration, the offboarding runbook, `CONFIG_ENCRYPTION_KEY` rotation,
the `RECOVERY_DISABLE_AUTH` break-glass, and logout semantics.
