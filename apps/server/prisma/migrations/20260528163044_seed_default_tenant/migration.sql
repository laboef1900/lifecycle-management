-- Every request runs in `tenantId='default'` (see apps/server/src/plugins/
-- tenant-context.ts). Cluster/host/application/event rows all FK to
-- `tenants.id`, so the `default` Tenant row must exist or every write 500s
-- with `Foreign key constraint violated on the constraint:
-- clusters_tenant_id_fkey` (Prisma P2003).
--
-- Previously this row was only created by prisma/seed.ts, so deployments
-- with SEED_ON_BOOT=false hit P2003 on the first POST /api/clusters.
-- Mirror the memory_gb migration (20260528080711_seed_memory_metric_type)
-- and idempotently insert the required row here.
INSERT INTO "tenants" ("id", "name", "created_at", "updated_at")
VALUES ('default', 'Default', NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;
