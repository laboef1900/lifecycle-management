-- CreateTable
CREATE TABLE "order_approvals" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "cluster_id" TEXT NOT NULL,
    "breach_month" DATE NOT NULL,
    "order_by_date" DATE NOT NULL,
    "lead_time_weeks" INTEGER NOT NULL,
    "warn_threshold" DOUBLE PRECISION NOT NULL,
    "capacity_signature" DOUBLE PRECISION NOT NULL,
    "metric_type_id" TEXT,
    "approved_by_user_id" TEXT,
    "approved_by_label" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_approvals_cluster_id_created_at_idx" ON "order_approvals"("cluster_id", "created_at");

-- AddForeignKey
ALTER TABLE "order_approvals" ADD CONSTRAINT "order_approvals_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_approvals" ADD CONSTRAINT "order_approvals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
