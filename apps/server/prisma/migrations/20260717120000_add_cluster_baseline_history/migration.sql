-- Append-only baseline history (#177, epic #172).
--
-- EXPAND + MIGRATE only. Nothing is dropped, nothing is rewritten in place.
-- `cluster_metric_baselines` and `clusters.baseline_date` are both retained and
-- dual-written by the application for one release, so rolling `LCM_IMAGE_TAG`
-- back to the previous image remains safe indefinitely. A later CONTRACT
-- migration drops them once that release has proven itself.
--
-- Why dual-write rather than migrating in place: after an in-place migration the
-- old code's `cluster.baselines[0]` would return an ARBITRARY row from an
-- unordered set (its uniqueness guarantee having come from the old composite
-- primary key), and would pair that arbitrary value with a fresh, correct
-- `baseline_date` — so the fleet tile's staleness check reports "healthy" while
-- showing a years-old capacity number. A wrong forecast that trips no detector
-- is the worst available failure mode for a value that drives hardware
-- purchasing. Dual-write's failure mode is merely a *stale* value, which the
-- existing staleness flag already catches. Recorded decision Q4, 2026-07-17 —
-- see docs/vsphere-integration-design.md §D36.

CREATE TABLE "cluster_baseline_history" (
    "id" TEXT NOT NULL,
    "cluster_id" TEXT NOT NULL,
    "metric_type_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "captured_at" DATE NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "observed_at" TIMESTAMPTZ(3),
    "baseline_consumption" DECIMAL(18,3) NOT NULL,
    "baseline_capacity" DECIMAL(18,3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cluster_baseline_history_pkey" PRIMARY KEY ("id")
);

-- `captured_at` IS the period anchor, so this unique constraint IS monthly
-- idempotency: both manual entry and the vSphere snapshot job snap it to the
-- first of the month, so a job that restarts and re-runs on a different day of
-- the same month recomputes the same key and conflicts rather than appending a
-- second competing truth for that period. Enforced by Postgres, not by
-- application logic — the guard that would otherwise fail under exactly the
-- concurrency it exists to prevent.
--
-- `source` is deliberately absent from the key: including it would let a manual
-- row and a vsphere row coexist for one period, making "the newest baseline"
-- ambiguous and forcing an implicit tiebreak on the number that buys hardware.
CREATE UNIQUE INDEX "cluster_baseline_history_period_unique"
    ON "cluster_baseline_history"("cluster_id", "metric_type_id", "captured_at");

ALTER TABLE "cluster_baseline_history" ADD CONSTRAINT "cluster_baseline_history_cluster_id_fkey"
    FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cluster_baseline_history" ADD CONSTRAINT "cluster_baseline_history_metric_type_id_fkey"
    FOREIGN KEY ("metric_type_id") REFERENCES "metric_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cluster_baseline_history" ADD CONSTRAINT "cluster_baseline_history_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- BACKFILL. Every existing baseline becomes the cluster's first history row,
-- anchored at the cluster's `baseline_date`.
--
-- This is what makes the migration provably behaviour-preserving. Today
-- `clusters.baseline_date` is ONE date shared by every metric of a cluster
-- (services/clusters.ts passes it into computeForecast for each metric in turn);
-- after this migration each history row carries its own `captured_at`. Seeding
-- them all from the same `baseline_date` reproduces today's semantics exactly,
-- so divergence can only begin with a FUTURE write — never retroactively.
--
-- `clusters.baseline_date` is DATE NOT NULL (see the init migration), so no NULL
-- branch is needed. Archived clusters are included deliberately: their baselines
-- must survive, and archival is not deletion.
--
-- gen_random_uuid() supplies the surrogate key because Prisma's cuid() is
-- generated client-side and is unavailable here. The column is opaque — nothing
-- parses it — so the mixed cuid/uuid formats are harmless.
INSERT INTO "cluster_baseline_history" (
    "id", "cluster_id", "metric_type_id", "tenant_id",
    "captured_at", "source", "observed_at",
    "baseline_consumption", "baseline_capacity"
)
SELECT
    gen_random_uuid()::text,
    b."cluster_id",
    b."metric_type_id",
    b."tenant_id",
    c."baseline_date",
    'manual',
    NULL,
    b."baseline_consumption",
    b."baseline_capacity"
FROM "cluster_metric_baselines" b
JOIN "clusters" c ON c."id" = b."cluster_id";

-- Fail the migration rather than start Fastify on a partial backfill. Each
-- Prisma migration runs in a transaction, so raising here rolls the whole thing
-- back atomically and the container entrypoint's `prisma migrate deploy` exits
-- non-zero — the server never boots, serving nothing rather than serving wrong
-- numbers. That is the intended failure mode for purchasing-critical data.
DO $$
DECLARE
    old_count BIGINT;
    new_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO old_count FROM "cluster_metric_baselines";
    SELECT COUNT(*) INTO new_count FROM "cluster_baseline_history";
    IF old_count <> new_count THEN
        RAISE EXCEPTION
            'Baseline history backfill incomplete: % source rows produced % history rows. Refusing to proceed.',
            old_count, new_count;
    END IF;
END $$;
