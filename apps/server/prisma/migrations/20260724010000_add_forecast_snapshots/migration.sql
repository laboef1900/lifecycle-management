-- Forecast snapshots: what the forecast PROJECTED at each re-anchor, compared
-- later against measured actuals (cluster_baseline_history) for the empirical
-- uncertainty band. See docs/design/forecast-uncertainty-band.md. Additive;
-- projected_util is a FRACTION of capacity (same unit as the forecast line).
CREATE TABLE "forecast_snapshot" (
    "id" TEXT NOT NULL,
    "cluster_id" TEXT NOT NULL,
    "metric_type_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "anchor_month" DATE NOT NULL,
    "horizon_month" DATE NOT NULL,
    "horizon_index" INTEGER NOT NULL,
    "projected_util" DECIMAL(9,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forecast_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "forecast_snapshot_unique" ON "forecast_snapshot"("cluster_id", "metric_type_id", "anchor_month", "horizon_month");

-- CreateIndex
CREATE INDEX "forecast_snapshot_cluster_metric_idx" ON "forecast_snapshot"("cluster_id", "metric_type_id");

-- AddForeignKey
ALTER TABLE "forecast_snapshot" ADD CONSTRAINT "forecast_snapshot_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecast_snapshot" ADD CONSTRAINT "forecast_snapshot_metric_type_id_fkey" FOREIGN KEY ("metric_type_id") REFERENCES "metric_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecast_snapshot" ADD CONSTRAINT "forecast_snapshot_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
