/*
  Warnings:

  - A unique constraint covering the columns `[tenant_id,serial_number]` on the table `hosts` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "host_state" AS ENUM ('ordered', 'racked', 'in_service', 'degraded', 'decommissioned', 'disposed');

-- AlterTable
ALTER TABLE "hosts" ADD COLUMN     "eol_at" DATE,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "purchased_at" DATE,
ADD COLUMN     "run_past_eol" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "serial_number" TEXT,
ADD COLUMN     "state" "host_state" NOT NULL DEFAULT 'in_service',
ADD COLUMN     "vendor" TEXT,
ADD COLUMN     "warranty_ends_at" DATE;

-- CreateTable
CREATE TABLE "host_lifecycle_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "host_id" TEXT NOT NULL,
    "from_state" "host_state",
    "to_state" "host_state" NOT NULL,
    "occurred_at" DATE NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "host_lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "host_replacements" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "old_host_id" TEXT NOT NULL,
    "new_host_id" TEXT NOT NULL,
    "swapped_at" DATE NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "host_replacements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "host_lifecycle_events_host_id_occurred_at_idx" ON "host_lifecycle_events"("host_id", "occurred_at");

-- CreateIndex
CREATE INDEX "host_replacements_swapped_at_idx" ON "host_replacements"("swapped_at");

-- CreateIndex
CREATE UNIQUE INDEX "host_replacements_old_host_id_new_host_id_key" ON "host_replacements"("old_host_id", "new_host_id");

-- CreateIndex
CREATE INDEX "hosts_state_idx" ON "hosts"("state");

-- CreateIndex
CREATE INDEX "hosts_eol_at_idx" ON "hosts"("eol_at");

-- CreateIndex
CREATE UNIQUE INDEX "hosts_tenant_serial_unique" ON "hosts"("tenant_id", "serial_number") WHERE "serial_number" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "host_lifecycle_events" ADD CONSTRAINT "host_lifecycle_events_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_lifecycle_events" ADD CONSTRAINT "host_lifecycle_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_replacements" ADD CONSTRAINT "host_replacements_old_host_id_fkey" FOREIGN KEY ("old_host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_replacements" ADD CONSTRAINT "host_replacements_new_host_id_fkey" FOREIGN KEY ("new_host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_replacements" ADD CONSTRAINT "host_replacements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill state from existing date columns
UPDATE "hosts"
SET "state" = CASE
  WHEN "decommissioned_at" IS NOT NULL AND "decommissioned_at" <= CURRENT_DATE
    THEN 'decommissioned'::"host_state"
  ELSE 'in_service'::"host_state"
END;

-- Seed lifecycle history so the audit log is non-empty for existing hosts
INSERT INTO "host_lifecycle_events" (id, tenant_id, host_id, from_state, to_state, occurred_at, note, created_at)
SELECT
  'seed_'       || id,
  tenant_id,
  id,
  NULL,
  'in_service'::"host_state",
  commissioned_at,
  'Backfilled from commissioned_at',
  NOW()
FROM "hosts"
ON CONFLICT (id) DO NOTHING;

INSERT INTO "host_lifecycle_events" (id, tenant_id, host_id, from_state, to_state, occurred_at, note, created_at)
SELECT
  'seed_decom_' || id,
  tenant_id,
  id,
  'in_service'::"host_state",
  'decommissioned'::"host_state",
  decommissioned_at,
  'Backfilled from decommissioned_at',
  NOW()
FROM "hosts"
WHERE decommissioned_at IS NOT NULL
ON CONFLICT (id) DO NOTHING;
