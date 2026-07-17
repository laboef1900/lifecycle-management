-- Inventory sync metadata on clusters and hosts (#176, epic #172).
--
-- Purely additive. `source` defaults to 'manual', so every existing cluster and
-- host keeps working exactly as before with no backfill — manual and synced
-- entities coexist by construction rather than by migration.

ALTER TABLE "clusters"
    ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
    ADD COLUMN "vsphere_connection_id" TEXT,
    ADD COLUMN "external_id" TEXT,
    ADD COLUMN "external_name" TEXT,
    ADD COLUMN "name_is_custom" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "last_synced_at" TIMESTAMP(3);

ALTER TABLE "hosts"
    ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
    ADD COLUMN "vsphere_connection_id" TEXT,
    ADD COLUMN "external_id" TEXT,
    ADD COLUMN "external_name" TEXT,
    ADD COLUMN "last_synced_at" TIMESTAMP(3),
    ADD COLUMN "commissioned_at_provisional" BOOLEAN NOT NULL DEFAULT false;

-- Identity WITHIN a vCenter. A MoRef (`domain-c123`) is unique only inside one
-- vCenter — two vCenters will both have one — so `external_id` alone is ambiguous
-- and the connection must be part of the key.
--
-- Matching on NAME instead would be worse than ambiguous: a vCenter-side rename
-- would look like delete+create and would destroy the cluster's baseline history.
-- MoRefs survive renames, which is exactly why they are the key.
--
-- Both columns are NULL for manual entities, and Postgres treats NULLs as
-- distinct, so every manual cluster and host coexists here — the same property
-- hosts_tenant_serial_unique already relies on.
CREATE UNIQUE INDEX "clusters_connection_external_unique"
    ON "clusters"("vsphere_connection_id", "external_id");

CREATE UNIQUE INDEX "hosts_connection_external_unique"
    ON "hosts"("vsphere_connection_id", "external_id");

-- ⚠️ ON DELETE RESTRICT, NEVER CASCADE.
--
-- cluster_metric_baselines and cluster_baseline_history both CASCADE from
-- clusters. A cascade here would therefore chain:
--
--     delete connection -> delete clusters -> DELETE EVERY BASELINE
--
-- One misclick in Settings would silently destroy the purchasing history this
-- epic exists to accumulate — and it would not even look destructive at the click
-- site. RESTRICT makes Postgres refuse; the API turns that into a 409 that lists
-- what would be affected and offers an explicit "detach" which converts the
-- clusters to manual and keeps every row.
--
-- SET NULL is also wrong: it leaves source='vsphere' with a null connection — a
-- row no code path expects — and makes the destructive path automatic rather than
-- deliberate.
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_vsphere_connection_id_fkey"
    FOREIGN KEY ("vsphere_connection_id") REFERENCES "vsphere_connections"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hosts" ADD CONSTRAINT "hosts_vsphere_connection_id_fkey"
    FOREIGN KEY ("vsphere_connection_id") REFERENCES "vsphere_connections"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
