-- The `memory_gb` MetricType is required by the frontend (hardcoded in every
-- cluster/host/application dialog). It was previously only created by
-- prisma/seed.ts, so deployments that ran migrations without SEED_ON_BOOT=true
-- could not create clusters (server returned "Unknown metric memory_gb").
INSERT INTO "metric_types" ("id", "key", "display_name", "unit")
VALUES (gen_random_uuid()::text, 'memory_gb', 'Memory', 'GB')
ON CONFLICT ("key") DO NOTHING;
