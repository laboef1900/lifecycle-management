# Operations runbook

Day-to-day operations for the self-hosted production deployment. For
architecture context start with the [`README`](../README.md).

## Deploy a new host from zero

1. **Provision** a Linux host with Docker Engine and Compose. Open port `80`
   (or whatever you set `HTTP_PORT` to) to the internal network.
2. **Clone** the repo to a stable path:
   ```bash
   sudo git clone https://github.com/laboef1900/lifecycle-management /opt/lcm
   cd /opt/lcm
   ```
3. **Configure** environment:
   ```bash
   cp .env.example .env
   # at minimum, set POSTGRES_PASSWORD; optionally LOG_LEVEL, HTTP_PORT
   chmod 600 .env  # the file holds DB credentials
   ```
4. **Pull** the published images:
   ```bash
   docker compose pull
   ```
   The `server` and `web` containers run pre-built images from
   `ghcr.io/laboef1900/lcm-{server,web}:latest` — there is no local build
   step. To pin a specific release, set `LCM_IMAGE_TAG=0.1` (or `dev`) in
   `.env`.
5. **First boot** with seed data:
   ```bash
   SEED_ON_BOOT=true docker compose up -d
   docker compose logs -f server   # confirm "No pending migrations to apply"
                                # and "Server listening at http://..."
   ```
6. **Disable the seed flag** in `.env` (set `SEED_ON_BOOT=false`) so future
   restarts skip the seeding step.
7. **Verify** end-to-end:
   ```bash
   curl -sf http://localhost/healthz   # {"status":"ok"}
   curl -sf http://localhost/readyz    # {"status":"ok"} once DB is reachable
   curl -s  http://localhost/api/clusters | head
   ```
   Browse to `http://<host>/` — you should see the dashboard with the four
   reference clusters.

## Daily operation

| Action                                          | Command                                     |
| ----------------------------------------------- | ------------------------------------------- |
| Start stack                                     | `docker compose up -d`                      |
| Stop stack                                      | `docker compose down`                       |
| Restart only the server (e.g. after env change) | `docker compose restart server`             |
| Tail server logs                                | `docker compose logs -f server`             |
| Check container health                          | `docker compose ps`                         |
| Open psql against the live DB                   | `docker compose exec db psql -U lcm -d lcm` |

The server image's entrypoint always runs `prisma migrate deploy` on start. It's
idempotent — already-applied migrations log `No pending migrations to apply`,
so restarting is cheap.

## Backups

The Postgres volume `lcm-postgres-18-data` holds everything. Take logical
backups with `pg_dump`:

```bash
# Quick snapshot to a host directory
mkdir -p /var/backups/lcm
docker compose exec -T db \
    pg_dump -U lcm -d lcm --format=custom --compress=9 \
  > /var/backups/lcm/lcm-$(date +%Y%m%d-%H%M%S).dump
```

Schedule via cron, for example daily at 02:00:

```cron
0 2 * * * cd /opt/lcm && docker compose exec -T db pg_dump -U lcm -d lcm --format=custom --compress=9 > /var/backups/lcm/lcm-$(date +\%Y\%m\%d).dump
```

### Restore

```bash
# Recreate the database (drops existing data)
docker compose exec -T db psql -U lcm -d postgres \
  -c 'DROP DATABASE IF EXISTS lcm WITH (FORCE);' \
  -c 'CREATE DATABASE lcm OWNER lcm;'

docker compose exec -T db pg_restore -U lcm -d lcm --no-owner --no-acl \
  < /var/backups/lcm/lcm-20260601.dump
```

After restoring, restart the server so it re-verifies migrations: `docker compose restart server`.

## Upgrade

```bash
cd /opt/lcm
git fetch && git checkout <new-tag-or-sha>   # pulls updated compose + docs

docker compose pull               # pulls the matching :latest images from GHCR
docker compose up -d              # recreates server + web, leaves db untouched
docker compose logs -f server     # watch for migrations being applied
```

If the new release adds a Prisma migration, you'll see it apply once and
then continue. The DB volume persists, so the upgrade is non-destructive.

To pin a specific release, set `LCM_IMAGE_TAG=0.2` (etc.) in `.env` instead
of relying on `:latest`. To roll back, set `LCM_IMAGE_TAG` to the prior tag
and `docker compose up -d`. **Caveat:** if the bad release applied a schema
migration, rolling back the image won't undo the schema change — restore
the DB from backup before rolling back if the schema diverges.

## Troubleshooting

### `server` won't start, logs show migration errors

Most likely a hand-edited migration file or a DB drift. Connect to the DB
and inspect:

```bash
docker compose exec db psql -U lcm -d lcm \
  -c "SELECT migration_name, finished_at, logs FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5;"
```

If a migration is marked `failed`, mark it as resolved per Prisma's docs and
retry, or restore from backup.

### `web` is healthy but `/api/*` returns 502

The Nginx upstream `server:8080` is unreachable. Check that the `server`
container is `(healthy)` in `docker compose ps`. If it's restarting, tail
its logs: `docker compose logs server`.

### Port conflict on `:80`

Another service is bound to port 80 on the host. Set `HTTP_PORT=8080` (or
anything free) in `.env` and re-run `docker compose up -d`.

### Dev DB collides with production DB

`docker/docker-compose.dev.yml` publishes Postgres on host port `5432`. The
production `db` service keeps Postgres inside the compose network only. Don't
run both at once on the same host; `pnpm db:dev:down` (or
`docker compose -f docker/docker-compose.dev.yml down`) before launching the
production stack.

### Seed re-ran by accident, duplicating data

The seed uses `upsert` keyed on cluster name + tenant + metric key, so re-runs
are no-ops for the reference clusters. Custom clusters created via the UI
are untouched.

### Stuck cluster won't delete

Cluster delete cascades to hosts/applications/events at the DB level (FK
`ON DELETE CASCADE`). If a delete fails, check `server` logs for the underlying
error — typically a constraint added by a future migration.

## What's not in v1

- CPU and disk metrics (schema-ready, no UI)
- Live hypervisor integration
- Excel import/export
- Multi-tenant enforcement (schema-only `tenant_id`)
- Audit log
- Alerting / thresholds
- Role enforcement — OIDC roles are stored (`users.role`) but not yet
  checked anywhere; every authenticated user has full access regardless of
  role. See "Authentication (OIDC)" below.

See the [vision](vision.md) for the rationale and roadmap.

## Authentication (OIDC)

Off by default (`AUTH_MODE=disabled`). When enabled, all `/api/*` routes
except `/api/auth/*` require a valid session; unauthenticated requests get
`401`. Health checks (`/healthz`, `/readyz`) are never gated.

**Role enforcement is deferred**: the OIDC role claim is mapped and stored
on the user record, but no route currently checks it — every signed-in user
has full access. Don't rely on `OIDC_ROLE_CLAIM` / `OIDC_ADMIN_VALUES` for
access control yet; use `OIDC_ALLOWED_EMAIL_DOMAINS` / `OIDC_ALLOWED_EMAILS`
or IdP-side app assignment instead.

### Enabling authentication

1. Set in `.env`: `AUTH_MODE=oidc`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET`, `APP_BASE_URL`, `LOGIN_STATE_SECRET` (see the
   "Authentication (OIDC)" block in `.env.example` for the full var list,
   including optional role/allowlist knobs).
2. `docker compose up -d` to recreate `server` with the new environment.
3. **Verify** — a stale compose file or a typo in `.env` silently leaves
   auth disabled, so always check:
   ```bash
   curl -si http://<host>/api/clusters | head -1     # must print HTTP/1.1 401
   curl -s  http://<host>/api/auth/me                # must print {"authRequired":true}
   ```
   Any other result means auth is NOT enabled.

### IdP registration

Register `lcm` as a confidential OIDC client at your IdP with a
single redirect URI:

```
${APP_BASE_URL}/api/auth/callback
```

`APP_BASE_URL` must exactly match the browser-facing origin — scheme,
host, and port included (e.g. `https://lcm.example.com`, not
`http://lcm.example.com:80` or a trailing slash). A mismatch shows up as
the IdP rejecting the redirect URI at the consent screen, not as a
server-side error.

### Offboarding a user

Deactivating or deleting the user at the IdP stops new logins, but any
session issued before deactivation stays valid for up to
`SESSION_TTL_HOURS` (default 12) — the server does not call back to the
IdP to check. To revoke access immediately:

```bash
docker compose exec db psql -U lcm -d lcm \
  -c "DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = 'user@example.com');"
```

### Secret rotation

- **`LOGIN_STATE_SECRET`**: signs the short-lived login-state cookie used
  only during the OIDC redirect round-trip. Rotating it (change the value,
  `docker compose up -d`) only aborts logins that are already in flight at
  the moment of restart — existing sessions are unaffected.
- **`OIDC_CLIENT_SECRET`**: rotate at the IdP first, then update `.env` and
  `docker compose up -d` in the same maintenance window. The old and new
  secrets are not valid simultaneously at most IdPs, so a gap between the
  two steps causes login failures (existing sessions still work).

### Logout semantics

Logout is local only: it clears the LCM session cookie and deletes the
session row. It does not call the IdP's end-session endpoint, so if the
IdP has an active SSO session, visiting the login flow again may
re-authenticate the user instantly without a credentials prompt. This is
expected — treat IdP-side logout as a separate action if it matters for
your environment.

### Plain-HTTP caveat

If you run the stack without TLS, OIDC credentials (the authorization
code exchange, session cookies) transit in cleartext between the browser,
this host, and the IdP. Put TLS in front of `web`'s nginx (a reverse
proxy or load balancer) before enabling auth on anything reachable outside
localhost. Most IdPs also refuse to register or use `http://` redirect
URIs except for `localhost`, so plain HTTP mainly only works for the local
Keycloak dev loop described in [`docker/README.md`](../docker/README.md).
