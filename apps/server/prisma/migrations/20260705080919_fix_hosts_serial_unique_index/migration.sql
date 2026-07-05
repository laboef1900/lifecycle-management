-- Replace the partial unique index with an equivalent full unique index.
--
-- Prisma cannot express the `WHERE serial_number IS NOT NULL` predicate, so
-- schema.prisma previously declared a plain `@@index` only to reserve the name.
-- That left schema and DB in disagreement (#123): any future `prisma migrate dev`
-- regenerated a spurious `CREATE INDEX "hosts_tenant_serial_unique"` that
-- collided with the existing index (P3018 / 42P07) and had to be hand-removed.
--
-- A full unique index is expressible as `@@unique` and is semantically identical
-- here: Postgres treats NULLs as distinct, so rows with NULL serial_number never
-- conflict under either index. Non-null serials remain unique per tenant.
DROP INDEX "hosts_tenant_serial_unique";
CREATE UNIQUE INDEX "hosts_tenant_serial_unique" ON "hosts"("tenant_id", "serial_number");
