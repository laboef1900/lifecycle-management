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
