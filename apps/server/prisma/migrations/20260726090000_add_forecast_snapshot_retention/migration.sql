-- Forecast snapshot retention (#318). Additive and NON-DESTRUCTIVE by itself:
-- the column defaults to 0 = keep forever, so applying this migration deletes
-- nothing and changes no existing behaviour. Pruning only ever happens after an
-- operator explicitly sets a window in Settings -> Forecasting.
-- Mirrors @lcm/shared DEFAULT_FORECAST_SNAPSHOT_RETENTION_MONTHS.
ALTER TABLE "tenant_settings" ADD COLUMN "forecast_snapshot_retention_months" INTEGER NOT NULL DEFAULT 0;

-- The band's read is now windowed on horizon_month (it selects one
-- cluster+metric over a bounded horizon range), so the range column joins the
-- covering index in last position. Rebuilt rather than added alongside: the
-- two-column index becomes a redundant prefix of the three-column one.
--
-- Plain DROP + CREATE, not CONCURRENTLY: the rebuild takes an ACCESS EXCLUSIVE
-- lock on forecast_snapshot for its duration, and it runs inside the migration
-- transaction so the index is never missing on a committed schema. That is the
-- right trade at this table's size (<= 300 rows/cluster/year, see the design doc
-- section 12) and only at this size. On a large table this shape would stall
-- writes for the length of the build -- do not copy it there without swapping to
-- CREATE INDEX CONCURRENTLY under a new name, which cannot run in a transaction
-- and so needs its own migration.
DROP INDEX "forecast_snapshot_cluster_metric_idx";
CREATE INDEX "forecast_snapshot_cluster_metric_idx" ON "forecast_snapshot"("cluster_id", "metric_type_id", "horizon_month");
