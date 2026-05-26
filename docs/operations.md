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
4. **Build** the two application images:
   ```bash
   docker compose build
   ```
5. **First boot** with seed data:
   ```bash
   SEED_ON_BOOT=true docker compose up -d
   docker compose logs -f api   # confirm "No pending migrations to apply"
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

| Action                                       | Command                                     |
| -------------------------------------------- | ------------------------------------------- |
| Start stack                                  | `docker compose up -d`                      |
| Stop stack                                   | `docker compose down`                       |
| Restart only the api (e.g. after env change) | `docker compose restart api`                |
| Tail api logs                                | `docker compose logs -f api`                |
| Check container health                       | `docker compose ps`                         |
| Open psql against the live DB                | `docker compose exec db psql -U lcm -d lcm` |

The api image's entrypoint always runs `prisma migrate deploy` on start. It's
idempotent — already-applied migrations log `No pending migrations to apply`,
so restarting is cheap.

## Backups

The Postgres volume `lcm-postgres-data` holds everything. Take logical
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

After restoring, restart the api so it re-verifies migrations: `docker compose restart api`.

## Upgrade

```bash
cd /opt/lcm
git fetch && git checkout <new-tag-or-sha>

docker compose build              # pulls latest base layers and re-bakes the images
docker compose up -d              # recreates api + web, leaves db untouched
docker compose logs -f api        # watch for migrations being applied
```

If the new release adds a Prisma migration, you'll see it apply once and
then continue. The DB volume persists, so the upgrade is non-destructive.

To roll back: `git checkout <previous-sha>` + `docker compose build` +
`docker compose up -d`. **Caveat:** if the bad release applied a schema
migration, rolling back the code won't undo the schema change — restore the
DB from backup before rolling back if the schema diverges.

## Troubleshooting

### `api` won't start, logs show migration errors

Most likely a hand-edited migration file or a DB drift. Connect to the DB
and inspect:

```bash
docker compose exec db psql -U lcm -d lcm \
  -c "SELECT migration_name, finished_at, logs FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5;"
```

If a migration is marked `failed`, mark it as resolved per Prisma's docs and
retry, or restore from backup.

### `web` is healthy but `/api/*` returns 502

The Nginx upstream `api:8080` is unreachable. Check that the `api` container
is `(healthy)` in `docker compose ps`. If it's restarting, tail its logs:
`docker compose logs api`.

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
`ON DELETE CASCADE`). If a delete fails, check `api` logs for the underlying
error — typically a constraint added by a future migration.

## What's not in v1

- Authentication / OIDC (planned for the 3-month milestone)
- CPU and disk metrics (schema-ready, no UI)
- Live hypervisor integration
- Excel import/export
- Multi-tenant enforcement (schema-only `tenant_id`)
- Audit log
- Alerting / thresholds

See the [vision](vision.md) for the rationale and roadmap.
