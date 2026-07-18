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

## Container hardening

The production stack already runs every service with `cap_drop: ALL`,
`no-new-privileges`, nonroot users, and mem/cpu/pid limits (see
`docker/docker-compose.yml`). The notes below cover the remaining
supply-chain and root-filesystem hardening (issue #94).

### Verifying image provenance and SBOM

The GHCR images (`lcm-{server,web}`) are built with **SLSA build provenance**
and an **SPDX SBOM** attached as OCI attestations (`publish-images.yml` sets
`provenance: true` + `sbom: true`). Inspect them from any host with Docker
Buildx — no registry write access needed:

```bash
# Human-readable provenance (build inputs, source commit, workflow)
docker buildx imagetools inspect ghcr.io/laboef1900/lcm-server:latest \
  --format '{{ json .Provenance }}'

# SBOM (SPDX package list) for the pulled image
docker buildx imagetools inspect ghcr.io/laboef1900/lcm-server:latest \
  --format '{{ json .SBOM }}'
```

Pin the digest you verified and deploy exactly that: set
`LCM_IMAGE_TAG` to a release tag, or reference the image by
`…@sha256:<digest>`.

**Keyless signature.** On every publish, `publish-images.yml` also signs the
pushed manifest with `actions/attest-build-provenance` — a keyless Sigstore
attestation (Fulcio certificate + Rekor transparency-log entry) bound to the
workflow's OIDC identity, with no long-lived keys held anywhere. Verify it on
the deploy host before rolling out (the digest that `verify` prints is the one
to pin):

```bash
gh attestation verify oci://ghcr.io/laboef1900/lcm-server:latest \
  --owner laboef1900
```

### Base-image digest pinning

Done: both Dockerfiles pin their `dhi.io` base images by digest
(`FROM dhi.io/node:26-alpine@sha256:…`, `dhi.io/nginx:1@sha256:…`), and the
compose `db` image is pinned the same way. Dependabot's docker ecosystem bumps
the pins — with the known caveat that `dhi.io` is a private registry without
configured credentials, so DHI digest bumps are **not** proposed automatically
(see `CLAUDE.md`); refresh them manually when the base images are updated.

### Read-only root filesystem

`server` runs with `read_only: true` + a `tmpfs` for `/tmp`. `db` and `web` do
**not** yet, because each needs a verified set of writable `tmpfs` mounts for
the paths its DHI base image writes to at runtime — and confirming those paths
requires running the images, which needs authenticated `dhi.io` access. The
candidate configuration (to validate against the actual images before
enabling in prod) is:

```yaml
db: # dhi.io/postgres:18 — data dir stays on the named volume (writable)
  read_only: true
  tmpfs:
    - /tmp
    - /var/run/postgresql # unix socket
web: # dhi.io/nginx:1 (distroless)
  read_only: true
  tmpfs:
    - /tmp
    - /var/cache/nginx
    - /var/run
```

Verify a candidate by adding it, running `docker compose up -d`, and confirming
the container reaches `healthy` (Postgres accepts connections; nginx serves the
SPA) with no read-only-filesystem errors in the logs. Do **not** enable
unverified — a missing writable path makes Postgres or nginx fail to boot.

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

### Verifying a dump is actually restorable

A dump you have never restored is a hypothesis, not a backup. Before any migration
that touches baselines, prove it against a throwaway database — never over the live
one:

```bash
# 1. Take the dump.
docker compose exec -T db pg_dump -U lcm -d lcm --format=custom --compress=9 \
  > /var/backups/lcm/pre-migration-$(date +%Y%m%d-%H%M%S).dump

# 2. Restore it into a scratch database ALONGSIDE the live one.
docker compose exec -T db psql -U lcm -d postgres -c 'CREATE DATABASE lcm_verify OWNER lcm;'
docker compose exec -T db pg_restore -U lcm -d lcm_verify --no-owner --no-acl \
  < /var/backups/lcm/pre-migration-<stamp>.dump

# 3. Row counts must match the live database EXACTLY for the purchasing-critical
#    tables. A dump that restores without error but is short a table is precisely
#    the failure this step exists to catch.
for t in clusters cluster_metric_baselines cluster_baseline_history hosts host_metric_capacities items item_allocations; do
  live=$(docker compose exec -T db psql -U lcm -d lcm        -tAc "SELECT COUNT(*) FROM $t")
  copy=$(docker compose exec -T db psql -U lcm -d lcm_verify -tAc "SELECT COUNT(*) FROM $t")
  printf '%-28s live=%-8s restored=%-8s %s\n' "$t" "$live" "$copy" \
    "$([ "$live" = "$copy" ] && echo OK || echo MISMATCH)"
done

# 4. Drop the scratch database once every line reads OK.
docker compose exec -T db psql -U lcm -d postgres -c 'DROP DATABASE lcm_verify WITH (FORCE);'
```

## Baseline history migration (#177) — rollback

The baseline-history migration is **expand + migrate only**: it creates
`cluster_baseline_history`, backfills it from `cluster_metric_baselines`, and
**drops nothing**. The application dual-writes both tables (and
`clusters.baseline_date`) for this release, so:

> **Rolling back is an ordinary image rollback, at any time, with no data loss:**
>
> ```bash
> # Pin the previous image in .env, then:
> docker compose up -d
> ```
>
> The old code reads `cluster_metric_baselines`, which the new code has kept
> current. The worst case is a baseline that is _stale_ — which the fleet tile's
> existing staleness flag already surfaces — never one that is silently wrong.

That property is the whole reason for the dual-write, and it is why the old table
must **not** be tidied away before the contract migration. Migrating in place would
have made an image rollback safe only until the first appended baseline, after
which the old code would pair an _arbitrary_ baseline value with a _fresh_ date — a
years-old capacity number displayed as current, tripping no staleness check, on the
number that drives hardware purchasing.

**If the migration itself fails, it fails safe with no action required.** Prisma
runs each migration in a transaction, so the DDL and the backfill roll back
together; the backfill's row-count assertion aborts the whole thing if it did not
copy every row; and the container's `prisma migrate deploy` then exits non-zero, so
**Fastify never starts**. The service serves nothing rather than serving wrong
numbers. Fix forward and redeploy.

> **`prisma migrate resolve --rolled-back` does NOT undo any DDL.** It only edits
> the `_prisma_migrations` bookkeeping table so a failed migration stops blocking
> the next `deploy`. Reading the flag name as "undo" leaves a database whose actual
> shape and whose recorded history disagree — worse than either problem alone.
> Prisma's documented recovery is roll **forward**.

**Before the later contract migration** (which drops `cluster_metric_baselines` and
`clusters.baseline_date`), take and _verify_ a dump as above: after it, an image
rollback is no longer possible and restore-from-dump becomes the only recovery.

## vCenter connections

Configure under **Settings → vCenter connections**. LCM reads capacity and never
writes to vSphere.

### Give LCM a read-only service account

**This is the single most valuable thing you can do for this integration**, and it
takes five minutes. Create a dedicated vCenter account with a read-only role
(`System.Read` on the relevant objects is sufficient) and use it here.

Every other control assumes the credential stays where it was put. This one assumes
it will not: it turns "virtualization estate compromise" into "capacity data
disclosure" — data LCM already serves from its own API in the default auth mode.

### Adding a connection

1. Enter a name, hostname, username and password.
2. **Check certificate** — this contacts the host and reads its certificate. **No
   credential is sent at this step**, deliberately: the certificate is vetted
   _before_ the password is ever transmitted.
3. If the certificate is self-signed (the VMCA default), LCM shows its SHA-256
   fingerprint. **Confirm it against vCenter before saving.** On a host with `govc`:
   ```bash
   govc about.cert -k -thumbprint -u <vcenter-host>
   ```
   The vSphere Client shows the same value under Administration → Certificates.
4. **Save connection.**

If the certificate is signed by a CA your system already trusts, there is nothing
to confirm and the panel says so.

### Changing a saved connection

**Changing the hostname or username requires re-entering the password.** This is
not a UI nicety — it is the control that protects the credential. In the default
`disabled` auth mode every request carries an anonymous ADMIN principal, so the only
thing distinguishing you from anyone else who can reach the server is knowledge of
the vCenter password. Without that gate, anyone could repoint a saved connection at
a host they control and simply wait for the next scheduled poll to hand them the
credential.

Renaming a connection or disabling it needs no password: neither can disclose
anything.

Changing the hostname also clears the pinned certificate and the discovered vCenter
identity — the old vCenter's certificate proves nothing about a new host, so trust
is re-established deliberately.

### How syncing works

Once a connection is saved and enabled, an in-process scheduler drives it — there is
nothing to cron and no worker to run. On boot the server starts one scheduler that,
per connection, does three things on their own cadences:

- **Poll** (~every 5 minutes) — reads live memory usage into a Postgres cache. This
  is what feeds the live-usage figures on the fleet console and cluster panel.
- **Sync** (~every 6 hours) — reads the host/cluster inventory (the PropertyCollector
  walk) and reconciles capacity. Hosts and clusters are created, updated, and marked
  missing; nothing in vSphere is ever written. Six hours is why _Sync now_ exists.
- **Snapshot** (monthly, on the first of the month) — captures the baseline the
  forecast reads. A snapshot always syncs first, so a baseline is never taken off
  stale inventory.

A newly added or re-enabled connection imports on the next tick rather than waiting
for a cadence boundary. Timestamps advance **on success only** — a failed poll or
sync stays due and retries under capped exponential backoff, so a transient vCenter
outage self-heals without operator action. A failure never silently becomes a
success: the connection's status and last-error reflect the real outcome (see
_Troubleshooting_).

The connection panel shows **last synced**, the **sync status**, and a **live-usage**
reading per synced cluster. "No sample yet" and a stale reading are shown as exactly
that — never as `0`, which would read as "empty and available" and is the one lie the
forecast must never tell.

### Sync now

**Settings → vCenter connections → Sync now** (admin only) schedules an immediate
run and returns straight away — it does not block on vCenter. The scheduler picks it
up within about a minute through the same path a scheduled run takes. If a full sync
completed recently, "Sync now" runs the cheap poll instead of a redundant full walk;
the 5-minute poll already covers "I just added a host in vCenter." Use it when you
have made a change in vSphere and do not want to wait for the next cadence.

### Disconnected and unreadable hosts

A host that vCenter reports as **not connected** (powered off at the host level, in a
failed-connection state, or otherwise not currently answering) is **excluded from
capacity** while it is in that state, with a warning in the server log. A disconnected
host is not providing memory to anything, so counting it would overstate capacity.
The host row is **never deleted** — it is marked missing and returns to the fleet on
the next successful sync once it reconnects.

The same applies to a connected host whose memory size cannot be read: it is skipped
with a log line rather than failing the whole vCenter's sync. One unreadable host no
longer stales every cluster on that vCenter.

### Provisional commissioning dates

vCenter does not record when a host was commissioned, so sync stamps an imported host
with a **provisional** commissioning date — the date LCM first saw it — and flags it.
The forecast treats months before a host's commissioning date as "unknown" rather
than zero, so the provisional date is safe but approximate. A cluster with unconfirmed
hosts shows an **_N_ hosts need commissioning dates** hint; confirm the real dates
under the cluster's **Hosts** tab (admin only, one date per host, applied atomically).
Confirming clears the flag; a re-sync never overwrites a confirmed date.
The initial host-capacity step moves with an earlier confirmed date, so historical
forecast months gain the capacity that was previously hidden behind the provisional
import date; later memory and availability changes keep their original dates.

### Sync-owned fields

On a **synced** cluster or host, the fields vSphere owns are read-only in LCM and
reject edits with a clear error — change them in vCenter and let the next sync
reconcile. Specifically: you cannot hand-add or delete a host under a synced cluster,
and you cannot set a non-zero **baseline capacity** on a synced cluster (host memory
carries the capacity; a non-zero baseline would double-count it and halve the
reported utilisation — the failure mode that quietly defers a hardware purchase).
Everything an operator legitimately owns stays editable: the display name (an edit
pins it, and sync stops overwriting the label), description, thresholds, lifecycle
transitions, archival, the commissioning-date confirmation above, and baseline
_consumption_ corrections.

### There is no "ignore TLS errors" option, by design

Self-signed vCenter certificates work through the fingerprint confirmation above,
with verification fully **on**. An insecure toggle would look like a convenience
setting and behave like a credential-disclosure channel: with verification off, the
saved hostname identifies a _name_ rather than a _host_, so anyone able to spoof
internal DNS collects the service-account password on **every poll**, silently, on
the happy path. Self-service internal DNS is common and needs no network position at
all.

If a connection reports **Certificate changed**, LCM has stopped talking to it on
purpose. Either the VMCA root was deliberately regenerated — in which case confirm
the new fingerprint and re-pin — or something is wrong. LCM will not decide which,
and will not re-pin by itself.

### Troubleshooting

| Status                      | Meaning                                                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Not yet connected**       | Saved, never contacted.                                                                                                                                                                                              |
| **Certificate not trusted** | Self-signed and not yet confirmed. Use _Check certificate_.                                                                                                                                                          |
| **Certificate changed**     | The presented CA differs from the pinned one. Confirm and re-pin, or investigate.                                                                                                                                    |
| **Sign-in failed**          | Host reachable, credentials rejected.                                                                                                                                                                                |
| **Different vCenter**       | The hostname now answers as a _different_ vCenter instance. Sync is blocked deliberately: cluster ids are only unique within one vCenter, so syncing would overwrite the wrong clusters' capacity.                   |
| **Credential unreadable**   | `CONFIG_ENCRYPTION_KEY` is missing, wrong, or rotated. The encrypted password is **preserved** — restore the correct key and the connection recovers. Never re-enter it as a "fix" until you have ruled the key out. |
| **Unreachable**             | No answer. Detail is in the server log, correlated by request id — the API response is deliberately coarse, because a precise one would let anyone reachable use this endpoint to map your internal network.         |

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

- **Losing the key, or booting with the wrong one** (unset, or changed to a
  value that can't decrypt what's already stored — e.g. mid-rotation,
  before the secret has been re-entered): the server detects it can't
  decrypt the stored secret at boot, logs an error, and forces
  `mode=disabled` automatically — it does **not** wipe the encrypted
  columns, so restoring the correct key (missing or wrong, it doesn't
  matter which) on a later boot recovers the configuration exactly as it
  was. This is graceful either way — a missing key and a present-but-wrong
  key both fail safe the same way, and neither crashes the server.
- **Deliberately rotating to a new key**: do this in a maintenance window.
  Update `CONFIG_ENCRYPTION_KEY` in `.env`, `docker compose up -d`, then go
  to **Settings → Authentication** and re-enter the client secret (the new
  key cannot decrypt ciphertext written under the old one) and save — this
  also re-tests discovery and generates a fresh login-state signing
  secret. Existing sessions are unaffected; only the OIDC test/save step
  needs the secret re-entered. If the server happens to restart on the new
  key before you reach Settings (or the rotation was accidental), it boots
  fine in `mode=disabled` with the old ciphertext untouched instead of
  crash-looping — either finish the re-entry step above, or roll
  `CONFIG_ENCRYPTION_KEY` back to the previous value to recover the
  existing configuration without re-entering anything.
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

## Local admin accounts

A third auth mode, `local`, complements (or substitutes for) OIDC: username-and-password accounts stored in the `users` table, with the password argon2id-hashed (`@node-rs/argon2`) — never bcrypt. They're managed from the running app's **Settings → Authentication** panel (admin-gated, same as the OIDC config), in a "Local accounts" list. The password policy is a minimum of 12 characters (no composition rules — length beats complexity per OWASP); accounts default to the `ADMIN` role but `VIEWER` is also selectable.

### Bootstrapping the first local admin

1. While still in the default `disabled` mode — its admin gate is open, so every request is the anonymous ADMIN principal — open **Settings → Authentication** and create a local admin account.
2. Switch `mode` to `local` and save. The server refuses the switch with a `422 NO_LOCAL_ADMIN` if there is no enabled local admin yet, so you can't flip to `local` and lock yourself out.
3. Once `local` mode is active, the server also refuses to disable, demote to `VIEWER`, or delete the **last** enabled local admin (`422 LAST_LOCAL_ADMIN`) — there must always be at least one enabled local admin while `local` mode is on. This guard only applies while `local` mode is the active mode.

### Break-glass alongside OIDC

Local login (`POST /api/auth/local/login`) is not exclusive to `local` mode — it also works while `mode: oidc` is active, as long as at least one enabled local admin exists. This gives you a non-IdP way in if the IdP is unreachable or misbehaving, without having to change the stored mode. To enforce strict OIDC-only access, disable or delete the local accounts — the last-admin guard above only applies while `local` mode is active, so in `oidc` mode you're free to remove all of them. With none left, `/api/auth/me`'s `loginMethods.local` reports `false` and the local login form is hidden.

### Lockout

After 5 consecutive failed login attempts, an account locks with exponential backoff: 1 minute, doubling on each further consecutive failure, capped at 15 minutes. A successful login resets the failure counter (and any active lock).

### Recovery

The existing break-glass path covers local accounts too: set `RECOVERY_DISABLE_AUTH=true` in `.env` and `docker compose up -d` — this forces `mode=disabled` regardless of what's stored in the DB, so you can reset a password or create a fresh admin from **Settings → Authentication**, then set `RECOVERY_DISABLE_AUTH=false` (or remove it) and restart to resume normal operation. No new environment variable was introduced for local accounts — this reuses the same flag documented under "Break-glass: RECOVERY_DISABLE_AUTH" above.

> `CONFIG_ENCRYPTION_KEY` is **not** required for `local` mode. The argon2id password hashes live directly on the `users` table, not in the AES-GCM-encrypted `auth_config` row — only `oidc` mode needs the encryption key, to store the OIDC client secret.
