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

Off by default (`mode: disabled`). When enabled, all `/api/*` routes
except `/api/auth/*` require a valid session; unauthenticated requests get
`401`. Health checks (`/healthz`, `/readyz`) are never gated.

Auth configuration is **DB-backed**: a single encrypted `auth_config` row
holds the issuer URL, client ID, client secret, and the rest of the OIDC
settings, and is managed from the running app's **Settings →
Authentication** panel (admin-only once oidc mode is active) rather than
by editing env vars and redeploying. The `AUTH_MODE` / `OIDC_*` env vars
documented in `.env.example` are **seed-only**: they're read exactly once,
on first boot while the `auth_config` table is still empty, to pre-populate
the row for unattended provisioning; every subsequent boot ignores them
even if you change `.env` and restart. `CONFIG_ENCRYPTION_KEY` is required
to store a client secret — see below.

**Role enforcement is deferred**: the OIDC role claim is mapped and stored
on the user record, but no route currently checks it — every signed-in user
has full access. Don't rely on `OIDC_ROLE_CLAIM` / `OIDC_ADMIN_VALUES` for
access control yet; use `OIDC_ALLOWED_EMAIL_DOMAINS` / `OIDC_ALLOWED_EMAILS`
or IdP-side app assignment instead.

### Configuring authentication

1. Make sure `CONFIG_ENCRYPTION_KEY` is set in `.env` — the compose file
   refuses to start `server` without it (fail-closed, same as
   `POSTGRES_PASSWORD`). Generate one with `openssl rand -base64 32` and
   never change it casually; see "CONFIG_ENCRYPTION_KEY rotation" below.
2. Sign in as (or create) an admin, open **Settings → Authentication**,
   fill in the issuer URL, client ID, client secret, app base URL, and any
   optional role/allowlist fields, and save. The server always re-tests
   OIDC discovery against the IdP before it will flip the stored mode to
   `oidc` — a save that fails the test leaves the previous config
   untouched, so you can't half-enable a broken configuration.
3. **Verify** — a misconfiguration should never silently leave auth off,
   but always confirm:
   ```bash
   curl -si http://<host>/api/clusters | head -1     # must print HTTP/1.1 401
   curl -s  http://<host>/api/auth/me                # must print {"authRequired":true}
   ```
   Any other result means auth is NOT enabled.

Alternatively, to provision OIDC without ever touching the UI (e.g.
scripted first-boot setup), set `AUTH_MODE=oidc` plus the `OIDC_*` vars in
`.env` _before_ the very first boot against an empty database — they seed
the row once. This only works while `auth_config` has no row yet; on any
later boot, use Settings → Authentication instead.

### CONFIG_ENCRYPTION_KEY rotation

`CONFIG_ENCRYPTION_KEY` (base64 of 32 random bytes) encrypts the stored
OIDC client secret and the app-generated login-state signing secret. It is
required to enable OIDC at all — without it, `auth_config` seeds (and
stays) disabled, and the settings UI can't persist a client secret either.
This is a fail-safe, not a crash: a missing or invalid key never takes the
server down.

- **Losing the key** (or restarting with it unset after OIDC was enabled):
  the server detects it can't decrypt the stored secret at boot, logs an
  error, and forces `mode=disabled` automatically — it does **not** wipe
  the encrypted columns, so restoring the original key on a later boot
  recovers the configuration exactly as it was.
- **Deliberately rotating to a new key**: do this in a maintenance window.
  Update `CONFIG_ENCRYPTION_KEY` in `.env`, `docker compose up -d`, then go
  to **Settings → Authentication** and re-enter the client secret (the new
  key cannot decrypt ciphertext written under the old one) and save — this
  also re-tests discovery and generates a fresh login-state signing
  secret. Existing sessions are unaffected; only the OIDC test/save step
  needs the secret re-entered.
- Never commit `CONFIG_ENCRYPTION_KEY` or check it into version control —
  treat it like `POSTGRES_PASSWORD`.

### Break-glass: RECOVERY_DISABLE_AUTH

If you're locked out (e.g. the only ADMIN account can't sign in, or the
IdP is unreachable and there's no other way to get in) set
`RECOVERY_DISABLE_AUTH=true` in `.env` and `docker compose up -d`. On that
boot the server forces `mode=disabled` regardless of what's stored in the
DB, so every `/api/*` route becomes reachable without a session — sign in
is not required, so use this only for as long as it takes to fix the
underlying problem. Once you've regained access (fixed the admin account,
reconfigured OIDC via Settings → Authentication, etc.), set
`RECOVERY_DISABLE_AUTH=false` (or remove it) and `docker compose up -d`
again to resume normal operation.

> **SECURITY NOTE — bootstrap/break-glass exposure.** Whenever auth is
> disabled — the initial bootstrap window before any admin exists, or any
> time `RECOVERY_DISABLE_AUTH` or the `CONFIG_ENCRYPTION_KEY` fail-safe has
> forced it off — the Settings → Authentication API (`GET`/`PUT
/api/settings/auth`, `POST /api/settings/auth/test`) is reachable by
> **anyone** who can reach the server, with no session required. The test
> and save endpoints perform a live OIDC discovery request to whatever
> issuer URL the caller supplies, i.e. an unauthenticated caller can make
> the server issue outbound HTTP requests to an attacker-chosen host
> (SSRF-adjacent). Configure authentication (or clear the break-glass
> flag) promptly, and keep the deployment on a trusted network — behind a
> firewall/VPN, not exposed to the open internet — during initial setup or
> while any break-glass override is active.

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

- **Login-state signing secret**: signs the short-lived login-state cookie
  used only during the OIDC redirect round-trip. It's generated by the
  server and stored encrypted in `auth_config` — there's no env var for it
  anymore (`LOGIN_STATE_SECRET` in `.env.example` is accepted for
  backward-compat validation but has no effect). Rotate it with **Settings
  → Authentication → Rotate signing secret** (`POST
/api/settings/auth/rotate-signing-secret`, admin-only). Rotating only
  aborts logins that are already in flight at the moment of rotation —
  existing sessions are unaffected.
- **`OIDC_CLIENT_SECRET`**: rotate at the IdP first, then update it via
  **Settings → Authentication** in the same maintenance window (the save
  re-tests discovery with the new secret before persisting it). The old
  and new secrets are not valid simultaneously at most IdPs, so a gap
  between the two steps causes login failures (existing sessions still
  work). A `CONFIG_ENCRYPTION_KEY` rotation also requires re-entering this
  secret — see "CONFIG_ENCRYPTION_KEY rotation" above.

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
