-- Scheduling state, one row per vCenter connection (#178, epic #172).
--
-- Additive: a new table, nothing existing touched.
--
-- vsphere_connection_id is BOTH the primary key and the foreign key. That is the
-- design, not tidiness:
--
--   * One row per connection means ONE claim per connection, so intra-connection
--     concurrency is structurally impossible rather than defended against — and
--     "sync before snapshot" becomes sequential statements inside one claimed job
--     body, with no second row to race.
--
--   * The FK cascades, so deleting a connection cannot strand an orphan row that
--     ticks and fails forever against a vCenter that no longer exists. A generic
--     jobs table keyed by an encoded name string ('vsphere.sync:<id>') could not
--     express either property.
--
-- CASCADE here does not contradict the RESTRICT on clusters.vsphere_connection_id.
-- The rule is: cascade is correct for regenerable operational state; forbidden for
-- irreplaceable user data. This row is pure derived state — the next tick rebuilds
-- it. A baseline is irreplaceable: a destroyed August cannot be re-measured.
CREATE TABLE "vsphere_connection_jobs" (
    "vsphere_connection_id" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "running_since" TIMESTAMP(3),
    "locked_by" TEXT,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "last_poll_at" TIMESTAMP(3),
    "last_sync_at" TIMESTAMP(3),
    "last_sync_status" TEXT,
    "last_snapshot_at" TIMESTAMP(3),
    "last_snapshot_status" TEXT,
    "last_snapshot_period" DATE,
    "last_success_period" DATE,
    "last_error" TEXT,

    CONSTRAINT "vsphere_connection_jobs_pkey" PRIMARY KEY ("vsphere_connection_id")
);

-- The tick's only query: "is anything due?"
CREATE INDEX "vsphere_connection_jobs_due_at_idx" ON "vsphere_connection_jobs"("due_at");

ALTER TABLE "vsphere_connection_jobs" ADD CONSTRAINT "vsphere_connection_jobs_vsphere_connection_id_fkey"
    FOREIGN KEY ("vsphere_connection_id") REFERENCES "vsphere_connections"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
