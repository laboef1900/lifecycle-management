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
DROP INDEX "forecast_snapshot_cluster_metric_idx";
CREATE INDEX "forecast_snapshot_cluster_metric_idx" ON "forecast_snapshot"("cluster_id", "metric_type_id", "horizon_month");
