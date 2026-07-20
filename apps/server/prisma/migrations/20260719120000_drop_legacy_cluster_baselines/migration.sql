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
-- lcm:step-start orphan-baseline-guard
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
-- lcm:step-end orphan-baseline-guard

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
-- SCOPE — what this step does NOT cover. It only closes the SAME-month case,
-- where snapping makes the correction and the backfill collide (the guard) or
-- coincide. A correction that re-anchored to a DIFFERENT month is untouched by
-- normalisation: an operator who re-dated a baseline to a period OLDER than the
-- backfilled `baseline_date` left the stale backfill row holding
-- MAX(captured_at), so it becomes the served row while the legacy table was
-- serving the correction. Both guards above pass — the (cluster, metric) history
-- row exists, and the two rows are in different months. Guard 3 below is what
-- catches that one, by comparing values rather than dates.
--
-- The guard runs first so a database where snapping would COLLAPSE two rows into
-- one period fails the deploy for operator-reviewed cleanup, rather than having
-- the collision resolved by an implicit tiebreak on numbers that buy hardware.
-- Prisma runs each migration in a transaction, so the RAISE rolls the whole thing
-- back and `prisma migrate deploy` exits non-zero — Fastify never starts.
--
-- @ai-warning The `lcm:step-start` / `lcm:step-end` sentinels are load-bearing:
-- baseline-history-migration.test.ts slices these statements out of THIS file and
-- executes them against seeded rows, so the suite exercises the shipped SQL
-- instead of a copy that can drift away from it. Keep them if you edit the steps.
-- Every guard in this file carries them, guard 1 included: it was the one guard
-- with neither sentinels nor a test, and guard 3's correctness argument leans on
-- it, so a typo narrowing its NOT EXISTS correlation would have made it vacuous
-- with nothing anywhere failing.

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

-- GUARD 3 — the served VALUE must survive the drop.
--
-- Guards 1 and 2 ask date questions: does a history row exist, and would snapping
-- destroy one? Neither can see the different-month case described above, and it is
-- the one that silently changes a purchasing number. Reproduced against this
-- migration before this guard existed: baseline_date 2026-06-20, so the expand
-- backfill wrote history@2026-06-20 = 100; the operator later corrected the
-- baseline re-anchoring backwards, writing history@2026-03-01 = 250 and (dual
-- write) legacy = 250. 250 is what clients were served. After the DROP,
-- newest-per-metric is MAX(captured_at) = the normalised 2026-06-01 row = 100.
-- Observed: 250 -> 100, no error, and no way to reach the correct row through the
-- API afterwards.
--
-- It IS detectable, and an earlier revision of this file wrongly claimed it was
-- not ("after the legacy table is gone there is no record of which row was being
-- served"). That reasoning confused when the DROP happens with when the guard
-- runs. Every guard here runs BEFORE the DROP, inside the same transaction, with
-- `cluster_metric_baselines` fully populated and holding exactly what the
-- application was serving. Comparing the two sides is all the detection takes, and
-- the window for it closes one statement later.
--
-- Placed AFTER normalisation on purpose: "newest" must be computed on the
-- `captured_at` values the application will actually see once this migration
-- commits, not on the pre-snap ones.
--
-- It also DEPENDS on guard 1 having already passed. The join below is an INNER
-- join, so a legacy row with no history row at all would simply not be compared —
-- exactly the case that would lose its value outright. Guard 1 proves that case
-- does not exist, which is what makes this guard's coverage total over the legacy
-- table rather than merely over the pairs that happen to match. (That argument
-- only became sound when the source predicate below was removed: a WHERE clause
-- dropping pairs independently of guard 1 made "total" false no matter what guard
-- 1 proved. Guard 1 now carries step sentinels and tests of its own for the same
-- reason — this guard's correctness leans on it.)
--
-- @ai-warning NO SOURCE PREDICATE, DELIBERATELY. An earlier revision restricted
-- this to a newest row with source='manual', justified as a false-positive
-- exclusion: "a manual cluster later connected to vCenter legitimately holds a
-- newer, authoritative `vsphere` row whose numbers do not match the stale legacy
-- value nobody has written since." Both halves were wrong.
--
-- "Nobody has written since" is provably false. The legacy table was last-write-
-- wins in WALL-CLOCK order, while `newest` below is computed in PERIOD order. When
-- an operator's correction is the most recent WRITE but is anchored to an EARLIER
-- period than an existing vSphere snapshot, the newest-by-period row is 'vsphere',
-- the pair was excluded, and the served value silently flipped. Reproduced
-- empirically: pre-drop 500, post-drop 900, migration reports success.
--
-- And "authoritative" answers the wrong question. This guard does not ask which
-- number is better; it asks whether the number SERVED changes when the legacy
-- table goes. Pre-drop the served value IS the legacy value, because `toResponse`
-- read that table; post-drop it is the newest-by-period row. So "they differ" is
-- exactly "the served value changes", which is precisely what the operator must
-- review — including when the newer row is a genuine snapshot. Both remediation
-- shapes are documented and executable: see "Guard 3" in docs/operations.md.
--
-- A blocked deploy is cheap here and a silently changed purchasing number is not.
-- Clusters synced from birth have no legacy row at all and the INNER JOIN excludes
-- them — do not make it a LEFT JOIN.
--
-- Compared on the NUMERIC type. Both columns are DECIMAL(18,3), so Postgres has
-- already normalised the scale on each side and 250 vs 250.000 cannot arise here
-- — but comparing the values rather than a text rendering is the property that
-- keeps that true if either column's scale is ever widened. `IS DISTINCT FROM`
-- rather than `<>` for the same reason: both columns are NOT NULL today, and a
-- NULL slipping in must read as a difference, not swallow the whole row.

-- lcm:step-start legacy-value-comparison-guard
DO $$
DECLARE
    divergent_count BIGINT;
    divergent_sample TEXT;
BEGIN
    WITH newest AS (
        -- One row per (cluster, metric): the period unique index makes
        -- `captured_at` unique within a pair, so DISTINCT ON is deterministic.
        SELECT DISTINCT ON (h."cluster_id", h."metric_type_id")
               h."cluster_id",
               h."metric_type_id",
               h."baseline_consumption",
               h."baseline_capacity"
        FROM "cluster_baseline_history" h
        ORDER BY h."cluster_id", h."metric_type_id", h."captured_at" DESC
    ),
    divergent AS (
        SELECT c."name" AS cluster_name, m."key" AS metric_key
        FROM "cluster_metric_baselines" b
        JOIN newest n
          ON n."cluster_id" = b."cluster_id"
         AND n."metric_type_id" = b."metric_type_id"
        JOIN "clusters" c ON c."id" = b."cluster_id"
        JOIN "metric_types" m ON m."id" = b."metric_type_id"
        WHERE n."baseline_consumption" IS DISTINCT FROM b."baseline_consumption"
           OR n."baseline_capacity" IS DISTINCT FROM b."baseline_capacity"
    )
    SELECT
        (SELECT COUNT(*) FROM divergent),
        (SELECT string_agg(cluster_name || '/' || metric_key, ', ' ORDER BY cluster_name, metric_key)
         FROM (SELECT * FROM divergent ORDER BY cluster_name, metric_key LIMIT 20) AS capped)
    INTO divergent_count, divergent_sample;

    IF divergent_count <> 0 THEN
        RAISE EXCEPTION
            'Refusing to drop cluster_metric_baselines: % (cluster, metric) pair(s) disagree between the legacy baseline and the newest cluster_baseline_history row, so dropping the legacy table would silently change the value served for them. Affected (up to 20 shown): %. Reconcile them before deploying — see "Guard 3" under the migration-failure runbook in docs/operations.md.',
            divergent_count, divergent_sample;
    END IF;
END $$;
-- lcm:step-end legacy-value-comparison-guard

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
