-- CreateEnum
CREATE TYPE "event_category" AS ENUM ('growth', 'hardware_change', 'openshift', 'note');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_types" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,

    CONSTRAINT "metric_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clusters" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "baseline_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cluster_metric_baselines" (
    "cluster_id" TEXT NOT NULL,
    "metric_type_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "baseline_consumption" DECIMAL(18,3) NOT NULL,
    "baseline_capacity" DECIMAL(18,3) NOT NULL,

    CONSTRAINT "cluster_metric_baselines_pkey" PRIMARY KEY ("cluster_id","metric_type_id")
);

-- CreateTable
CREATE TABLE "hosts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "cluster_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "commissioned_at" DATE NOT NULL,
    "decommissioned_at" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "host_metric_capacities" (
    "id" TEXT NOT NULL,
    "host_id" TEXT NOT NULL,
    "metric_type_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "effective_from" DATE NOT NULL,
    "amount" DECIMAL(18,3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "host_metric_capacities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "cluster_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "started_at" DATE NOT NULL,
    "ended_at" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_metric_allocations" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "metric_type_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "effective_from" DATE NOT NULL,
    "amount" DECIMAL(18,3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_metric_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "cluster_id" TEXT NOT NULL,
    "metric_type_id" TEXT NOT NULL,
    "effective_date" DATE NOT NULL,
    "category" "event_category" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "consumption_delta" DECIMAL(18,3),
    "capacity_delta" DECIMAL(18,3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "metric_types_key_key" ON "metric_types"("key");

-- CreateIndex
CREATE UNIQUE INDEX "clusters_tenant_name_unique" ON "clusters"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "hosts_cluster_id_idx" ON "hosts"("cluster_id");

-- CreateIndex
CREATE UNIQUE INDEX "host_metric_capacities_host_id_metric_type_id_effective_fro_key" ON "host_metric_capacities"("host_id", "metric_type_id", "effective_from");

-- CreateIndex
CREATE INDEX "applications_cluster_id_idx" ON "applications"("cluster_id");

-- CreateIndex
CREATE UNIQUE INDEX "application_metric_allocations_application_id_metric_type_i_key" ON "application_metric_allocations"("application_id", "metric_type_id", "effective_from");

-- CreateIndex
CREATE INDEX "events_cluster_id_effective_date_idx" ON "events"("cluster_id", "effective_date");

-- AddForeignKey
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cluster_metric_baselines" ADD CONSTRAINT "cluster_metric_baselines_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cluster_metric_baselines" ADD CONSTRAINT "cluster_metric_baselines_metric_type_id_fkey" FOREIGN KEY ("metric_type_id") REFERENCES "metric_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cluster_metric_baselines" ADD CONSTRAINT "cluster_metric_baselines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosts" ADD CONSTRAINT "hosts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosts" ADD CONSTRAINT "hosts_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_metric_capacities" ADD CONSTRAINT "host_metric_capacities_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_metric_capacities" ADD CONSTRAINT "host_metric_capacities_metric_type_id_fkey" FOREIGN KEY ("metric_type_id") REFERENCES "metric_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_metric_capacities" ADD CONSTRAINT "host_metric_capacities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_metric_allocations" ADD CONSTRAINT "application_metric_allocations_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_metric_allocations" ADD CONSTRAINT "application_metric_allocations_metric_type_id_fkey" FOREIGN KEY ("metric_type_id") REFERENCES "metric_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_metric_allocations" ADD CONSTRAINT "application_metric_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_metric_type_id_fkey" FOREIGN KEY ("metric_type_id") REFERENCES "metric_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
