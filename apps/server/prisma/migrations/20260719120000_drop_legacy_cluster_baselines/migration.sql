-- CONTRACT: drop the legacy baseline table and the per-cluster baseline date (#195).
--
-- Completes the expand/migrate/contract sequence begun in
-- 20260717120000_add_cluster_baseline_history. `cluster_baseline_history` has been
-- the forecast's read side since that release; as of this release it is also the
-- only source of ClusterResponse.metrics and ClusterResponse.baselineDate, and the
-- application no longer dual-writes. Both objects dropped below are now dead weight.
--
-- IRREVERSIBLE, and it closes the rollback window the expand migration deliberately
-- left open. After this runs, rolling LCM_IMAGE_TAG back to a pre-#177 image cannot
-- boot: the old code SELECTs columns that no longer exist. `prisma migrate resolve
-- --rolled-back` edits the _prisma_migrations bookkeeping only — it does not undo
-- DDL. The sole recovery is restore-from-dump. Take and VERIFY a pg_dump first, per
-- docs/operations.md "Verifying a dump is actually restorable".
--
-- Note for future readers: 20260717160000_add_sync_metadata carries a comment
-- naming `cluster_metric_baselines` in its ON DELETE RESTRICT rationale. That
-- comment is stale as of this migration and is deliberately NOT edited — rewriting
-- an applied migration changes its checksum and fails `migrate deploy` on every
-- existing deployment. The argument survives unchanged on cluster_baseline_history,
-- which still cascades from clusters.
--
-- The guard below refuses the drop if any legacy baseline lacks a history row, so an
-- incomplete backfill fails the deploy instead of destroying data. Prisma runs each
-- migration in a transaction, so the RAISE rolls the whole thing back atomically and
-- the container entrypoint's `prisma migrate deploy` exits non-zero — Fastify never
-- starts, serving nothing rather than serving wrong numbers.
DO $$
DECLARE
    orphan_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO orphan_count
    FROM "cluster_metric_baselines" b
    WHERE NOT EXISTS (
        SELECT 1
        FROM "cluster_baseline_history" h
        WHERE h."cluster_id" = b."cluster_id"
          AND h."metric_type_id" = b."metric_type_id"
    );
    IF orphan_count <> 0 THEN
        RAISE EXCEPTION
            'Refusing to drop cluster_metric_baselines: % baseline(s) have no cluster_baseline_history row. Backfill is incomplete.',
            orphan_count;
    END IF;
END $$;

-- NORMALISE `captured_at` to the first of its month, BEFORE the legacy table goes.
--
-- 20260717120000_add_cluster_baseline_history backfilled `captured_at` from
-- `clusters.baseline_date` VERBATIM — no date_trunc — and that column stored
-- whatever day an operator typed: `dateOnly` in @lcm/shared is a bare YYYY-MM-DD
-- regex with no first-of-month refinement, and the create dialog is a free
-- `<input type="date">`. Every other writer snaps through `startOfUtcMonth`, so a
-- pre-#177 cluster can hold the single mid-month row in this table.
--
-- Harmless only while the legacy table was the read side. From this migration on,
-- `ClusterResponse.metrics` and `.baselineDate` are newest-per-metric =
-- MAX(captured_at) — and a stale 2026-01-15 backfill row outranks the 2026-01-01
-- correction the application wrote beside it during the dual-write release. The
-- legacy table held only the correction, which is what clients actually saw, so
-- for a correction landing in THAT SAME MONTH the drop would otherwise swap in
-- pre-correction numbers on the fleet console, the cluster panel and the
-- forecast, with no error raised and no way to reach the correct row through the
-- API. The #177 orphan guard above does not catch it: a history row for that
-- (cluster, metric) does exist.
--
-- SCOPE — what this step does NOT cover. It only closes the same-month case,
-- where snapping makes the correction and the backfill collide (the guard) or
-- coincide. A correction that re-anchored to a DIFFERENT month is untouched by
-- normalisation and still changes displayed values: an operator who re-dated a
-- baseline to a period OLDER than the backfilled `baseline_date` left the stale
-- backfill row holding MAX(captured_at), so it becomes the served row while the
-- legacy table was serving the correction. Both guards pass — the (cluster,
-- metric) history row exists and the two rows are in different months — and
-- nothing here can tell the two apart, because after the legacy table is gone
-- there is no record of which row was being served. This is a deliberate,
-- documented value change rather than a defect to detect: see "After this
-- migration: what changed for operators" in docs/operations.md.
--
-- The guard runs first so a database where snapping would COLLAPSE two rows into
-- one period fails the deploy for operator-reviewed cleanup, rather than having
-- the collision resolved by an implicit tiebreak on numbers that buy hardware.
-- Prisma runs each migration in a transaction, so the RAISE rolls the whole thing
-- back and `prisma migrate deploy` exits non-zero — Fastify never starts.
--
-- @ai-warning The `lcm:step-start` / `lcm:step-end` sentinels are load-bearing:
-- baseline-history-migration.test.ts slices these two statements out of THIS file
-- and executes them against seeded rows, so the suite exercises the shipped SQL
-- instead of a copy that can drift away from it. Keep them if you edit the steps.

-- lcm:step-start normalise-captured-at-guard
DO $$
DECLARE
    collision_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO collision_count
    FROM (
        SELECT 1
        FROM "cluster_baseline_history"
        GROUP BY "cluster_id", "metric_type_id", date_trunc('month', "captured_at")
        HAVING COUNT(*) > 1
    ) AS collisions;
    IF collision_count <> 0 THEN
        RAISE EXCEPTION
            'Refusing to normalise cluster_baseline_history.captured_at: % (cluster, metric, month) group(s) hold more than one row, so snapping to the first of the month would destroy a measurement. Reconcile them by hand first.',
            collision_count;
    END IF;
END $$;
-- lcm:step-end normalise-captured-at-guard

-- lcm:step-start normalise-captured-at
UPDATE "cluster_baseline_history"
SET "captured_at" = date_trunc('month', "captured_at")::date
WHERE "captured_at" <> date_trunc('month', "captured_at")::date;
-- lcm:step-end normalise-captured-at

DROP TABLE "cluster_metric_baselines";

-- `clusters.baseline_date` was one operator-declared date shared by every metric.
-- ClusterResponse.baselineDate is now DERIVED as MIN over the newest captured_at
-- per metric — the stalest tracked metric — so the column has no reader left. The
-- day-of-month it carried is not recoverable from history and is not wanted:
-- captured_at is a PERIOD anchor and every writer snaps it to the first of the
-- month, so a derived value may read up to 30 days earlier than the column did.
-- That shifts baseline ages by up to 30 days and can move a cluster across the
-- 90-day staleness threshold, with no code change on the web side.
ALTER TABLE "clusters"
    DROP COLUMN "baseline_date";
