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
#
#    NOTE: `cluster_metric_baselines` was dropped by #195 and is absent from this
#    list. When verifying a dump taken from a database that PREDATES that
#    migration, add it back for that run — the table exists in the dump, and
#    leaving it unchecked skips the very rows the migration is about to remove.
for t in clusters cluster_baseline_history hosts host_metric_capacities items item_allocations; do
  live=$(docker compose exec -T db psql -U lcm -d lcm        -tAc "SELECT COUNT(*) FROM $t")
  copy=$(docker compose exec -T db psql -U lcm -d lcm_verify -tAc "SELECT COUNT(*) FROM $t")
  printf '%-28s live=%-8s restored=%-8s %s\n' "$t" "$live" "$copy" \
    "$([ "$live" = "$copy" ] && echo OK || echo MISMATCH)"
done

# 4. Drop the scratch database once every line reads OK.
docker compose exec -T db psql -U lcm -d postgres -c 'DROP DATABASE lcm_verify WITH (FORCE);'
```

## Baseline history migration (#177/#195) — rollback

**The contract migration has landed.** `20260719120000_drop_legacy_cluster_baselines`
dropped `cluster_metric_baselines` and `clusters.baseline_date`, and the application
no longer dual-writes. `cluster_baseline_history` is the only baseline store: it
anchors the forecast, it is what `ClusterResponse.metrics` is built from, and
`ClusterResponse.baselineDate` is derived from it as the MIN of the newest
`captured_at` per metric.

> **An image rollback to a pre-#177 tag is NO LONGER POSSIBLE.** The old code
> `SELECT`s `cluster_metric_baselines` and `clusters.baseline_date`, which no longer
> exist, so it cannot boot. **Restore-from-dump is the only recovery** — see
> "Verifying a dump is actually restorable" above, and take the dump _before_
> deploying the image that carries this migration.

Until this migration, rolling back was an ordinary image rollback with no data loss,
and that property was the entire reason for the dual-write: migrating in place would
have made a rollback safe only until the first appended baseline, after which the old
code would pair an _arbitrary_ baseline value with a _fresh_ date — a years-old
capacity number displayed as current, tripping no staleness check, on the number that
drives hardware purchasing. That window is now deliberately closed.

**If the migration itself fails, it fails safe — but it does not fix itself.** Prisma
runs each migration in a transaction, so a failure rolls the whole thing back: no
table is dropped, no `captured_at` is rewritten, and the database is left exactly as
the previous release left it. `prisma migrate deploy` then exits non-zero and
**Fastify never starts**, so the service serves nothing rather than serving wrong
numbers. Your data is intact: this is a **blocked deploy, not corruption**.

> ⚠️ **It is still a full outage, and rolling the image back does not end it.**
> Prisma writes the failed attempt into `_prisma_migrations` _outside_ the
> migration's transaction, so Postgres rolling the migration back does not clear it —
> the row survives with `finished_at` and `rolled_back_at` both NULL. Every
> subsequent `prisma migrate deploy` then stops at **P3009**
> (`migrate found failed migrations in the target database`) and exits 1. That
> includes the **previous image**: Prisma's failed-migration check reads the database
> records only and never intersects them with the migrations on disk, so an image
> whose migrations directory does not even contain this migration still refuses.
> `entrypoint.ts` exits on that non-zero status, Fastify never starts,
> `restart: unless-stopped` restart-loops `server`, and `web`'s
> `depends_on: condition: service_healthy` keeps the whole stack down.
>
> **Clearing the record is therefore part of restoring service, not only part of
> rolling forward** — see "Clearing the failed-migration record" below. Roll forward
> (the normal path): fix the data per the guard you hit, clear the record, redeploy.
> Need the previous image serving _now_: clear the record first, then deploy the old
> tag — the schema still matches it, because the migration did roll back. The
> `migrate resolve` command works from either image; it addresses the record by
> migration name and does not need that migration present on disk.
>
> _Verified end to end against PostgreSQL 18 with Prisma 7.8: guard RAISE → P3018 and
> exit 1, DDL rolled back and rows intact; `migrate deploy` from a migrations directory
> lacking the migration → P3009 and exit 1; `migrate resolve --rolled-back` from that
> same directory → exit 0, and `migrate deploy` then boots clean._

Two guards can stop it, and they call for different responses. Read the RAISE message
in `docker compose logs server` to tell them apart.

#### Guard 1 — orphaned legacy baselines

> `Refusing to drop cluster_metric_baselines: N baseline(s) have no cluster_baseline_history row. Backfill is incomplete.`

The #177 expand migration did not copy every legacy row. It asserts its own row
counts, so reaching this state means that assertion was bypassed (a hand-applied
migration, or a restore that mixed schema versions). **Remedy: complete the backfill**
— re-run the expand migration's `INSERT ... SELECT` for the missing pairs — then
resume at "Clearing the failed-migration record" below.

#### Guard 2 — a `captured_at` collision

> `Refusing to normalise cluster_baseline_history.captured_at: N (cluster, metric, month) group(s) hold more than one row, so snapping to the first of the month would destroy a measurement. Reconcile them by hand first.`

**This is the one you are likely to actually hit, and "complete the backfill" is a
dead end for it — the backfill is already complete.** It arises from ordinary use of
the previous release:

1. A pre-#177 cluster carries `baseline_date = 2026-01-15`. Nothing forbade the day:
   `dateOnly` in `@lcm/shared` is a bare `YYYY-MM-DD` regex with no first-of-month
   refinement, and the create dialog is a free `<input type="date">`.
2. The expand migration backfilled `captured_at = 2026-01-15` **verbatim**.
3. During the dual-write release an operator edited a baseline **value** without
   touching the date. That path snapped through `startOfUtcMonth` and appended
   `2026-01-01`, while `clusters.baseline_date` stayed `2026-01-15`.

Both rows now sit in January, so snapping the first onto the second would silently
destroy one. The guard refuses instead.

It is **deterministically resolvable**, and the discriminator is structural rather
than value-based: **the mid-month row is always the stale backfill.**

Every application writer snaps to the first of the month —
`ClustersService.create` and `update` through `startOfUtcMonth`,
`VsphereSnapshotService` through `startOfUtcMonth(measuredAt)`, and `seed.ts`
likewise. The expand migration's `SELECT c."baseline_date"` is the only writer that
ever stored a mid-month `captured_at`, and it wrote at most **one** row per
`(cluster, metric)` because that was the legacy table's primary key. So a colliding
group is always exactly one backfill row plus one snapped row written by the app, and
the row to drop is the one whose day is not `01`.

> Do **not** resolve this by matching the two rows against
> `cluster_metric_baselines` to see which one "was being served". That table is
> last-write-wins across **all** periods — `clusterMetricBaseline.upsert` is
> unconditional — so if the metric's most recent edit targeted a different month, the
> row it matches is the stale backfill and the value-based rule deletes the
> operator's correction. The day-of-month rule has no such failure mode.

```bash
# 1. Look at every colliding group, with what clients were being served alongside.
docker compose exec -T db psql -U lcm -d lcm <<'SQL'
SELECT c.name AS cluster, mt.key AS metric, h.captured_at, h.source,
       h.baseline_consumption, h.baseline_capacity,
       b.baseline_consumption AS served_consumption,
       b.baseline_capacity    AS served_capacity,
       ((h.baseline_consumption, h.baseline_capacity)
        IS NOT DISTINCT FROM (b.baseline_consumption, b.baseline_capacity)) AS was_served
FROM "cluster_baseline_history" h
JOIN "clusters" c      ON c.id  = h.cluster_id
JOIN "metric_types" mt ON mt.id = h.metric_type_id
LEFT JOIN "cluster_metric_baselines" b
       ON b.cluster_id = h.cluster_id AND b.metric_type_id = h.metric_type_id
WHERE (h.cluster_id, h.metric_type_id, date_trunc('month', h.captured_at)) IN (
        SELECT cluster_id, metric_type_id, date_trunc('month', captured_at)
        FROM "cluster_baseline_history"
        GROUP BY 1, 2, 3
        HAVING COUNT(*) > 1)
ORDER BY c.name, mt.key, h.captured_at;
SQL
```

```bash
# 2. Drop the mid-month backfill row in every colliding group. Self-verifying: the
#    guard at the end RAISEs if any collision survives, which rolls the whole
#    transaction back — there is no "remember to ROLLBACK" step to get wrong.
docker compose exec -T db psql -U lcm -d lcm -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

DELETE FROM "cluster_baseline_history" h
WHERE h."captured_at" <> date_trunc('month', h."captured_at")::date
  AND EXISTS (
        SELECT 1
        FROM "cluster_baseline_history" o
        WHERE o."cluster_id"     = h."cluster_id"
          AND o."metric_type_id" = h."metric_type_id"
          AND o."id"            <> h."id"
          -- The surviving sibling must be the SNAPPED row. Without this line a
          -- group of two MID-month rows satisfies the EXISTS in both directions
          -- and loses both, leaving no collision for the guard below to catch —
          -- so the transaction commits an emptied group.
          AND o."captured_at"    = date_trunc('month', o."captured_at")::date
          AND date_trunc('month', o."captured_at")
              = date_trunc('month', h."captured_at"));

-- Refuse to commit unless every group is now single-rowed, so an unanticipated
-- shape aborts instead of half-resolving.
DO $$
DECLARE
    remaining BIGINT;
BEGIN
    SELECT COUNT(*) INTO remaining FROM (
        SELECT 1 FROM "cluster_baseline_history"
        GROUP BY "cluster_id", "metric_type_id", date_trunc('month', "captured_at")
        HAVING COUNT(*) > 1) t;
    IF remaining <> 0 THEN
        RAISE EXCEPTION
            'Rolled back: % group(s) still collide after dropping mid-month rows. Two snapped rows cannot occur in one month (the period unique index forbids it) — stop and inspect before touching anything.',
            remaining;
    END IF;
END $$;

COMMIT;
SQL
```

The `EXISTS` clause is the safety property, and **both** of its conditions carry
weight: a mid-month row is dropped only when a row that is already snapped to the
first of the month shares its `(cluster, metric, month)`. Requiring the survivor to
be the snapped one is what makes "this statement cannot empty a group" true. Matching
merely "some other row in the same month" reads equivalent — the documented shape is
always one backfill row plus one snapped row — but on a group of **two mid-month
rows** each is the other's sibling, both are deleted, and the final `RAISE` then finds
no collision to complain about and commits the emptied group. An isolated mid-month
row is a legitimate lone measurement, which the migration's normalisation `UPDATE`
snaps without losing anything, so it is left alone either way.

If the final `RAISE` fires, the transaction is rolled back and nothing was changed.
Two cases reach it, and neither is resolved by deleting more rows:

- **Two mid-month rows in one group.** The `EXISTS` deliberately leaves them, because
  there is no structural rule saying which one to keep — the day-of-month
  discriminator only tells a backfill row from an application row, and here both look
  like backfill rows. The expand migration wrote at most one row per
  `(cluster, metric)`, so this should not arise from the dual-write history; treat it
  as a hand-edited or partially restored database and reconcile the two values with
  whoever recorded them.
- **Two _snapped_ rows sharing a month**, which the
  `cluster_baseline_history_period_unique` index makes impossible — so it likewise
  indicates corruption rather than the dual-write history this procedure covers.

Stop and investigate; do not delete rows to make the guard pass.

#### Clearing the failed-migration record

**Not optional, and not only a roll-forward step.** Prisma recorded the failed
attempt outside the migration's transaction, so the record outlived the rollback and
now refuses **every** `deploy` with **P3009**
(`migrate found failed migrations in the target database`) instead of retrying —
including a `deploy` run by an older image that never shipped this migration, which
is why an image rollback alone leaves the stack down (see the callout under "Baseline
history migration (#177/#195) — rollback"). Fixing the data is necessary but not
sufficient. Clear the record, then redeploy:

```bash
docker compose run --rm server node_modules/prisma/build/index.js migrate resolve \
  --rolled-back 20260719120000_drop_legacy_cluster_baselines
docker compose up -d
```

> **`prisma migrate resolve --rolled-back` does NOT undo any DDL.** It only edits
> the `_prisma_migrations` bookkeeping table so a failed migration stops blocking
> the next `deploy`. Reading the flag name as "undo" leaves a database whose actual
> shape and whose recorded history disagree — worse than either problem alone.
> Prisma's documented recovery is roll **forward**. It is honest _here_ only because
> Postgres genuinely did roll the whole migration back inside its transaction, so
> the recorded history and the actual schema already agree.

**Prerequisite record.** A `pg_dump` taken and verified per the row-count procedure
above is a hard prerequisite for deploying this migration, because it is the only
recovery path that survives it. Verify the dump using the **pre-migration** table
list — one that still includes `cluster_metric_baselines` — since that table exists
in the dump being checked and not in the schema afterwards.

### After this migration: what changed for operators

- **Baseline dates may read up to 30 days earlier.** `clusters.baseline_date` stored
  whatever day was typed; every `captured_at` is snapped to the first of its month.
  Baseline ages grow by up to 30 days accordingly, which can move a cluster across
  the 90-day staleness threshold with no code change on the web side.
- **Synced clusters now show metrics.** They previously showed "No metric configured"
  on the fleet console, because metrics came from a table the sync never wrote.
- **Synced clusters report utilization as unknown** where their baseline capacity is
  0 and their hosts carry the capacity — the documented Q9d/#200 intent, now visible.
- **Baseline VALUES may change on a cluster that was re-dated during the dual-write
  release**, specifically where that edit anchored the baseline to a period _older_
  than the backfilled `baseline_date`. `ClusterResponse.metrics` now follows the
  newest period rather than the last write, so the older correction stops outranking
  the stale backfill row and the displayed numbers revert to the backfill's. Neither
  migration guard catches this — the two rows are in different months, so nothing
  collides — and once `cluster_metric_baselines` is dropped there is no record of
  which row was previously served. **Spot-check any cluster whose baseline date was
  corrected backwards in that window** and re-enter the value if it reads wrong;
  saving it appends a correction at the newest period, which then wins outright.
- **A date-only baseline edit can now be refused.** Changing only the date re-dates
  an existing measurement, so it can move a baseline _backwards_ only. Submitting a
  later date alone returns 422 `BASELINE_PERIOD_NOT_MEASURED`, because there is no
  measurement for that period to move onto it and inventing one would absorb real
  consumption, shadow the month's vCenter snapshot, and clear the staleness flag
  without measuring anything. To record a baseline for a later period, submit its
  values — that appends a new measurement.

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

1. Enter a name, hostname, port (default 443), username and password.
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

> **SECURITY NOTE — vCenter connection testing.** While auth is `disabled`
> (the default) or under a break-glass override, **Check certificate**
> (`POST /api/settings/vsphere/probe`) and connection verification
> (`/api/settings/vsphere/verify`) are reachable by anyone who can reach the
> server, with no session. Because the port is configurable to any value in
> 1-65535, these endpoints can test whether an internal host answers TLS on
> an arbitrary port **from the server's network position** — a coarse
> internal port scanner (SSRF-adjacent). Every settings route that can probe,
> create, re-arm, or re-point this outbound work is rate-limited to 10
> requests/minute/IP. The background scheduler additionally claims at most
> five due connections per one-minute tick, oldest first. Established vCenters
> get priority and at most one slot is available to a connection that has never
> connected successfully, so anonymous first-contact rows cannot starve normal
> inventory work or turn the HTTP limit into unbounded concurrent background
> probes. These controls bound work; they do not make the endpoint a security
> boundary, and a determined caller on a trusted network can still sweep
> slowly. Responses are deliberately coarse —
> reachable or not, plus a certificate fingerprint, never the subject,
> issuer, or SANs. Private addresses are permitted by design (a vCenter is
> private). Stored credentials are never sent to a request-supplied host, and
> changing a saved connection's hostname or port requires re-entering the
> vCenter password; an untrusted certificate is pinned to an
> out-of-band-confirmed root and a change fails rather than silently
> trusting. Keep the deployment on a trusted network — behind a firewall/VPN,
> not exposed to the open internet — during setup or while any break-glass
> override is active, and use a read-only vCenter service account.

### Changing a saved connection

**Changing the hostname, port, or username requires re-entering the password.** This is
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
server down. Read "fail-safe" precisely, though — it means the server stays
_up_, not that the deployment stays _secured_. On a deployment storing
`mode: oidc`, an unreadable key degrades authentication to `disabled`, which
leaves the API open until the key is fixed. Decryption is gated on the stored
mode, so `local` and `disabled` rows never touch the encrypted columns and are
not degraded by an unreadable key at all. See the first bullet below before
treating this as a low-severity incident.

- **Losing the key, or booting with the wrong one, on a deployment storing
  `mode: oidc`** (unset, or changed to a value that can't decrypt what's
  already stored — e.g. mid-rotation,
  before the secret has been re-entered): the server detects it can't
  decrypt the stored secret at boot, logs an error, and forces
  `mode=disabled` automatically — it does **not** wipe the encrypted
  columns, so restoring the correct key (missing or wrong, it doesn't
  matter which) on a later boot recovers the configuration exactly as it
  was. A missing key and a present-but-wrong key behave identically, and
  neither crashes the server. The degrade is in-memory only: the stored
  `mode` still says `oidc`, so nothing has to be re-selected in Settings
  once the key is back.

  A stored `local` or `disabled` row is unaffected: its encrypted columns are
  never read, so an unreadable key changes nothing about how it boots. Such a
  row keeps enforcing exactly what it says.

  **Treat this as a security incident, not just an outage.** For as long as
  an **OIDC** deployment runs with an unreadable key, the effective mode is
  `disabled`: every `/api/*` route is reachable **without a session**, and every request
  is served as an anonymous **ADMIN** — exactly the exposure described under
  "Break-glass: RECOVERY_DISABLE_AUTH" below, including the SSRF-adjacent
  settings endpoints. The stored `oidc` mode being preserved does **not**
  mean authentication is being enforced. The degrade is decided at boot, so
  repairing `.env` alone changes nothing until the server is restarted — but a
  restart is not the only way out. **A successful save in Settings →
  Authentication closes the window immediately**: the degrade is recorded once
  at boot and never re-applied, so the reload that follows the write re-derives
  the enforced mode from it. Re-entering the client secret restores `oidc`
  enforcement on the spot (the save re-encrypts under whatever key is set now,
  so a rotated key works and only a missing one blocks it); saving `local`
  closes the API without needing a key. Saving `disabled` applies just as
  immediately but leaves the API open by design, and both non-`oidc` saves
  permanently delete the stored client secret (see "Switching away from OIDC
  deletes the stored client secret" below).

  Two signals make the state visible. In the logs, an `error`
  (`auth_config.open_despite_configuration`) is emitted on every boot where
  the enforced mode is `disabled` but the stored mode is not — the same line
  that marks a break-glass window, in any `NODE_ENV`. In the UI,
  **Settings → Authentication** shows the _stored_ mode alongside an explicit
  warning that authentication is currently force-disabled because the stored
  secrets cannot be decrypted, so the panel can no longer look like a normal,
  secured OIDC deployment while the API is open. The warning names the cause,
  because the recovery differs: a decryption failure is fixed by restoring or
  rolling back `CONFIG_ENCRYPTION_KEY` and restarting, whereas a break-glass
  window is closed by clearing `RECOVERY_DISABLE_AUTH` and restarting.

  Run the same post-episode account audit documented under "After a
  break-glass episode" below — the exposure was identical, so the review
  is too.

- **Caveat for `AUTH_STRICT_BOOT=true` deployments** (OIDC deployments only —
  see "Which stored modes refuse to boot" just below). Because the stored
  mode survives the degrade, the _next_ boot sees the same configured row
  it still can't decrypt and, under strict boot, **refuses to start**
  rather than fail open. That is what strict boot is for, but it changes
  "restart to resume normal operation" into "the server will not start
  until the key is fixed".

  **Which stored modes refuse to boot.** Only `oidc` — it is the only mode
  whose secrets are decrypted at boot, so it is the only mode a key failure
  can degrade. A stored `local` row no longer reaches this path: since
  decryption is gated on the stored mode, its leftover ciphertext is never
  read, the deployment keeps enforcing `local`, and there is nothing for
  strict boot to refuse.

  (This is **not** a return to the earlier `oidc`-only _scoping_ bug, where a
  `local` deployment with an unreadable key degraded to an open API despite
  `AUTH_STRICT_BOOT=true`. That fail-open is closed at the source now:
  `local` does not degrade, so it does not need refusing. The strict-boot
  predicate itself remains the divergence test `!== 'disabled'`, not a mode
  enumeration — what narrowed is which modes can reach it, not the test.)

  A stored mode of `disabled` still boots normally, even under strict boot,
  and now does so **structurally** rather than by exemption: its encrypted
  columns are never read, so no decrypt failure is raised in the first place.
  Such a row is also already open by the operator's own choice, so refusing it
  would be an outage with no security benefit. Rows carrying stale ciphertext
  still exist — switching OIDC → disabled used to leave the encrypted client
  secret behind — but saving a non-oidc mode now clears both secret columns,
  so that state stops accumulating on any deployment kept up to date.

  **Two recovery paths**, both requiring a restart:

  1. **Fix or roll back `CONFIG_ENCRYPTION_KEY`** — restore the correct
     key (or revert to the previous one if the rotation was the cause)
     and `docker compose up -d`. Nothing was written, so the stored mode
     comes back exactly as configured with nothing to re-enter. This is
     the preferred path: it never opens the API.
  2. **`RECOVERY_DISABLE_AUTH=true`** — deliberately boot with an open,
     unauthenticated API so you can repair the config from Settings. Use
     this only when path 1 isn't available, and treat the window as the
     security incident described under "Break-glass:
     RECOVERY_DISABLE_AUTH" below, post-episode account audit included.

  (`AUTH_STRICT_BOOT` is opt-in and is not forwarded by the shipped
  production compose file — it only applies if your deployment passes it
  into the `server` service.)

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
- **Switching away from OIDC deletes the stored client secret.** Saving
  `local` or `disabled` in **Settings → Authentication** clears both encrypted
  columns (client secret and login-state signing secret), so switching back to
  `oidc` later requires **re-entering the client secret** — there is nothing
  stored to fall back on. The attempt is refused with a clear
  `INCOMPLETE_OIDC_CONFIG` error rather than silently enabling OIDC without a
  secret, and the Settings panel shows an empty "Client secret" field instead
  of "•••••••• configured" to signal it up front.

  This reverses earlier behaviour, where the secret survived an
  OIDC → disabled → OIDC round trip untouched. It is deliberate: that
  surviving ciphertext is exactly what a later key rotation turned into a
  decrypt failure on a row that never needed the secret, which degraded the
  deployment to an open API. The same applies to first-boot seeding — supplying
  `OIDC_*` env vars while `AUTH_MODE` is unset or `disabled` seeds a disabled
  row and does not retain the client secret (logged as
  `auth_config.seeded_client_secret_discarded`; boot never fails over it).

  Because the deletion is irreversible — and specifically **not** undone by
  restoring `CONFIG_ENCRYPTION_KEY`, which is the recovery every other failure
  in this section relies on — **Settings → Authentication** asks for
  confirmation before sending a save that switches away from `oidc`, naming
  exactly what is deleted. The alert shown during a decrypt-degraded boot says
  the same thing: its "the encrypted secrets are intact and are never wiped"
  guarantee describes the **degrade**, not a save made from that screen.

  Submitting a client secret **alongside** a non-oidc mode is refused with
  `422 CLIENT_SECRET_NOT_APPLICABLE` rather than accepted and discarded — the
  save would have thrown the value away, and answering `200` would have hidden
  that until enabling OIDC later failed. Clear the field (or omit
  `clientSecret`) and the save proceeds; clearing needs no encryption key, so
  this never blocks a keyless deployment from leaving a broken OIDC config.

  Note this affects **explicit saves only**. A degraded boot still writes
  nothing at all, so the "fix the key and restart, with nothing to re-enter"
  recovery above is unchanged.

- Never commit `CONFIG_ENCRYPTION_KEY` or check it into version control —
  treat it like `POSTGRES_PASSWORD`.

### Break-glass: RECOVERY_DISABLE_AUTH

If you're locked out (e.g. the only ADMIN account can't sign in, or the
IdP is unreachable and there's no other way to get in) set
`RECOVERY_DISABLE_AUTH=true` in `.env` and `docker compose up -d`. On that
boot the server **overrides the effective mode to `disabled` in memory
only** — the stored configuration in the database is left untouched. Every
`/api/*` route becomes reachable without a session, so use this only for
as long as it takes to fix the underlying problem. The override is sticky
for the whole process: it survives in-session config reloads, so the
server can't lock you back out halfway through the recovery.

Once you've regained access (fixed the admin account, reconfigured OIDC
via Settings → Authentication, etc.), set `RECOVERY_DISABLE_AUTH=false`
(or remove it) and `docker compose up -d` again. Because the override
never wrote anything, that restores whatever mode was stored before the
incident — no re-selection in Settings required. Then run the verification
probe and the post-episode audit below.

Two boot log lines mark the window: a `warn` when the override is applied,
and an `error` (`auth_config.open_despite_configuration`) on every boot
where the enforced mode is `disabled` but the stored mode is not. The
second one is the one to search for during an incident review — it is the
only trace that the API was open, in any `NODE_ENV`.

While the flag is set, **Settings → Authentication** shows the _stored_
mode (not `disabled`) alongside a warning that authentication is currently
force-disabled by the break-glass flag. Changes you save there are
persisted, but they do not take effect until you clear the flag and
restart — the deliberate flag wins for the rest of that boot. Expect the
OIDC discovery status to read `disabled` next to a stored mode of `oidc`
for the same reason.

> **SECURITY NOTE — bootstrap/break-glass exposure.** Whenever auth is
> disabled — the initial bootstrap window before any admin exists, or any
> time `RECOVERY_DISABLE_AUTH` or the `CONFIG_ENCRYPTION_KEY` fail-safe
> (OIDC deployments only) has forced it off — the Settings → Authentication API (`GET`/`PUT
/api/settings/auth`, `POST /api/settings/auth/test`) is reachable by
> **anyone** who can reach the server, with no session required. The test
> and save endpoints perform a live OIDC discovery request to whatever
> issuer URL the caller supplies, i.e. an unauthenticated caller can make
> the server issue outbound HTTP requests to an attacker-chosen host
> (SSRF-adjacent). Configure authentication (or clear the break-glass
> flag) promptly, and keep the deployment on a trusted network — behind a
> firewall/VPN, not exposed to the open internet — during initial setup or
> while any break-glass override is active. The exposure window ends at the
> next boot without the flag: the override only ever lived in memory, so
> nothing has to be undone in the database to close it again.

#### If the IdP is down and won't recover in time

Clearing the flag will not get you back in: it restores `oidc`, and the
deployment is still broken. You also can't re-enable OIDC from Settings
while the IdP is unreachable — saving `mode: oidc` re-tests discovery
server-side and fails with `422 TEST_REQUIRED`. That gate is deliberate.
The supported procedure is to switch away from OIDC while break-glass is
still active:

1. **Settings → Authentication** → create a local admin account.
2. Set `mode` to `local` and save (refused with `422 NO_LOCAL_ADMIN` if
   there is no enabled local admin yet).
3. Set `RECOVERY_DISABLE_AUTH=false` (or remove it) and
   `docker compose up -d`. The server boots into `local` mode and you sign
   in with the account from step 1.

Switch back to `oidc` from Settings once the IdP is healthy again.

#### Verify the API is closed again

Do this after every break-glass episode. The failure mode this guards
against is silent — an app that renders normally looks identical whether
authentication is on or off:

```bash
curl -si http://<host>/api/clusters | head -1     # must print HTTP/1.1 401
curl -s  http://<host>/api/auth/me                # must print {"authRequired":true}
```

Anything else means authentication is still off.

### After a break-glass episode

While break-glass is active every request is an anonymous **ADMIN**, and
the last-admin guard is keyed to the stored `local` mode rather than the
overridden one. Anyone who could reach the server during the window could
have created an account or reset an existing password — and that access
survives after authentication is correctly restored. Treat this as
mandatory after **any** episode in which the API ran open, including past
ones — that means break-glass windows _and_ any **OIDC** boot degraded by an
unreadable `CONFIG_ENCRYPTION_KEY` (see that section above), since the
exposure is identical:

1. Audit the `users` table for accounts you don't recognise, and for admin
   roles you didn't grant:

   ```bash
   docker compose exec db psql -U lcm -d lcm \
     -c "SELECT id, issuer, subject, email, role, disabled, created_at, password_updated_at FROM users ORDER BY created_at DESC;"
   ```

   Anything created or with a password changed during the window is
   suspect. Delete unexpected accounts from **Settings → Authentication**.

2. Revoke every session, so any cookie issued during the window is dead:

   ```bash
   docker compose exec db psql -U lcm -d lcm -c "DELETE FROM sessions;"
   ```

   Everyone signs in again — that is the point. To revoke a single user
   instead, see "Offboarding a user" below.

3. Re-run the verification probe above.

Also re-check the vCenter connections and the OIDC issuer/client ID in
Settings: both are readable, and writable, without a session while auth is
off.

#### Were you affected by the pre-fix persistence bug?

Releases before this behaviour was fixed (issue #222) implemented the
break-glass override by **writing** `mode=disabled` into the stored
`auth_config` row. On those versions, clearing `RECOVERY_DISABLE_AUTH` and
restarting restored nothing: the deployment kept serving an open API, and
the UI gave no sign of it. No code change can recover the mode that row
used to hold. If this deployment ever ran break-glass on an older release:

- Check the effective mode from outside:
  `curl -s http://<host>/api/auth/me`. If it prints
  `{"authRequired":false}` while you believe authentication is configured,
  you were affected.
- Re-select the intended mode in **Settings → Authentication** and save
  (for `oidc` this re-tests discovery; for `local` you need an enabled
  local admin first).
- Then run the account audit and session revocation above. The exposure
  window may have been open for as long as the deployment has been
  running, so treat it as a real incident rather than a formality.

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

The existing break-glass path covers local accounts too — no new environment variable was introduced for them. Follow "Break-glass: RECOVERY_DISABLE_AUTH" above, including the verification probe and the post-episode account audit; resetting a password or creating a fresh admin from **Settings → Authentication** is exactly the recovery that section is written for.

> `CONFIG_ENCRYPTION_KEY` is **not** required for `local` mode. The argon2id password hashes live directly on the `users` table, not in the AES-GCM-encrypted `auth_config` row — only `oidc` mode needs the encryption key, to store the OIDC client secret, and only `oidc` reads it at boot. A `local` row that still carries leftover encrypted OIDC columns from an earlier configuration keeps them untouched and unread, so a missing, wrong, or rotated key leaves `local` enforcing exactly as configured. Saving `local` from Settings also clears those columns outright.
