-- Merge the `applications` and `events` tables into a single unified `items`
-- table (table `items`), rename `application_metric_allocations` to
-- `item_allocations`, and introduce a `categories` lookup table.
--
-- The old `applications` table is reused in-place as `items` (preserving its
-- rows + ids). Event rows are copied into `items` with kind='event'. Categories
-- are backfilled from the categories currently in use plus the canonical event
-- category names, per tenant.

-- 1. New enum
CREATE TYPE "item_kind" AS ENUM ('application', 'event');

-- 2. Rename applications -> items, allocations table + FK column
ALTER TABLE "applications" RENAME TO "items";
ALTER TABLE "application_metric_allocations" RENAME TO "item_allocations";
ALTER TABLE "item_allocations" RENAME COLUMN "application_id" TO "item_id";

-- 2a. Rename the primary keys, indexes and FK constraints that Postgres kept
-- under their old (applications / application_metric_allocations) names so the
-- live DB matches the names Prisma derives from the new table names.
ALTER INDEX "applications_pkey" RENAME TO "items_pkey";
ALTER INDEX "applications_cluster_id_idx" RENAME TO "items_cluster_id_idx";
ALTER TABLE "items" RENAME CONSTRAINT "applications_tenant_id_fkey" TO "items_tenant_id_fkey";
ALTER TABLE "items" RENAME CONSTRAINT "applications_cluster_id_fkey" TO "items_cluster_id_fkey";

ALTER INDEX "application_metric_allocations_pkey" RENAME TO "item_allocations_pkey";
ALTER INDEX "application_metric_allocations_application_id_metric_type_i_key" RENAME TO "item_allocations_item_id_metric_type_id_effective_from_key";
ALTER TABLE "item_allocations" RENAME CONSTRAINT "application_metric_allocations_application_id_fkey" TO "item_allocations_item_id_fkey";
ALTER TABLE "item_allocations" RENAME CONSTRAINT "application_metric_allocations_metric_type_id_fkey" TO "item_allocations_metric_type_id_fkey";
ALTER TABLE "item_allocations" RENAME CONSTRAINT "application_metric_allocations_tenant_id_fkey" TO "item_allocations_tenant_id_fkey";

-- 3. Reshape items
ALTER TABLE "items" RENAME COLUMN "started_at" TO "effective_date";
ALTER TABLE "items" ADD COLUMN "kind" "item_kind" NOT NULL DEFAULT 'application';
ALTER TABLE "items" ADD COLUMN "metric_type_id" TEXT;
ALTER TABLE "items" ADD COLUMN "consumption_delta" DECIMAL(18,3);
ALTER TABLE "items" ADD COLUMN "capacity_delta" DECIMAL(18,3);
ALTER TABLE "items"
  ADD CONSTRAINT "items_metric_type_id_fkey"
  FOREIGN KEY ("metric_type_id") REFERENCES "metric_types"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Copy events into items (reuse the event id)
INSERT INTO "items" (
  "id", "tenant_id", "cluster_id", "kind", "category", "name", "description",
  "effective_date", "ended_at", "metric_type_id", "consumption_delta",
  "capacity_delta", "created_at", "updated_at"
)
SELECT
  e."id", e."tenant_id", e."cluster_id", 'event'::"item_kind",
  CASE e."category"
    WHEN 'growth' THEN 'Growth'
    WHEN 'hardware_change' THEN 'Hardware'
    WHEN 'openshift' THEN 'OpenShift'
    WHEN 'note' THEN 'Note'
    ELSE e."category"::text
  END,
  e."title", e."description", e."effective_date", NULL, e."metric_type_id",
  e."consumption_delta", e."capacity_delta", e."created_at", e."updated_at"
FROM "events" e;

-- 5. Index to match schema (the second @@index on items)
CREATE INDEX "items_cluster_id_effective_date_idx" ON "items" ("cluster_id", "effective_date");

-- 6. Categories table
CREATE TABLE "categories" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL DEFAULT 'default',
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "categories_tenant_name_unique" ON "categories" ("tenant_id", "name");
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 7. Seed categories: every distinct category in use, per tenant
INSERT INTO "categories" ("id", "tenant_id", "name")
SELECT gen_random_uuid()::text, i."tenant_id", i."category"
FROM (SELECT DISTINCT "tenant_id", "category" FROM "items") i
ON CONFLICT ("tenant_id", "name") DO NOTHING;

-- 8. Always-available canonical event names for every tenant that has items
INSERT INTO "categories" ("id", "tenant_id", "name")
SELECT gen_random_uuid()::text, t."tenant_id", c."name"
FROM (SELECT DISTINCT "tenant_id" FROM "items") t
CROSS JOIN (VALUES ('Growth'), ('Hardware'), ('OpenShift'), ('Note')) AS c("name")
ON CONFLICT ("tenant_id", "name") DO NOTHING;

-- 9. Drop the old events table + enum
-- (Note: the `kind` column keeps its DEFAULT 'application'; schema.prisma
-- declares `@default(application)`, so dropping the default here would create
-- drift. The default is harmless for backfilled event rows, which set kind
-- explicitly in step 4.)
-- 10. Drop the old events table + enum
DROP TABLE "events";
DROP TYPE "event_category";
