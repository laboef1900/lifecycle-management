-- Live usage cache, one row per cluster (#179, epic #172).
--
-- A CACHE, not history. cluster_id is the primary key, so a poll upserts, the
-- table never grows, and no retention policy is needed. It must not become a time
-- series: history is what baselines are for, and conflating them would quietly
-- promote a cache into purchasing data.
--
-- In Postgres rather than memory, and that is required rather than preferred. The
-- server is stateless by invariant and must serve last-known data after a restart
-- with a staleness indicator. An in-memory cache fails exactly when it matters
-- most: a restart DURING a vCenter outage would leave the UI showing nothing at
-- all for the duration of the outage.
--
-- There is deliberately NO capacity column. Capacity is inventory — it changes
-- when a host is physically installed, on a scale of months, and nothing about it
-- is live. Duplicating it into a 5-minute cache with a different owner and cadence
-- would guarantee the two disagree, and a live view whose denominator contradicts
-- the forecast's is exactly how users stop trusting the tool. The synced inventory
-- is the one owner of capacity.
--
-- CASCADE is correct here: this row is regenerable operational state that the next
-- poll rebuilds. (Contrast clusters.vsphere_connection_id, which is RESTRICT
-- because baselines are irreplaceable.)
CREATE TABLE "vsphere_usage_samples" (
    "cluster_id" TEXT NOT NULL,
    "vsphere_connection_id" TEXT NOT NULL,
    "memory_used_gib" DECIMAL(18,3) NOT NULL,
    -- hosts_sampled < hosts_total is its own honest signal. Without it, a partial
    -- read looks like a real DROP in consumption rather than a partial read.
    "hosts_sampled" INTEGER NOT NULL,
    "hosts_total" INTEGER NOT NULL,
    -- When vCenter measured it, not when we asked.
    "measured_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vsphere_usage_samples_pkey" PRIMARY KEY ("cluster_id")
);

ALTER TABLE "vsphere_usage_samples" ADD CONSTRAINT "vsphere_usage_samples_cluster_id_fkey"
    FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vsphere_usage_samples" ADD CONSTRAINT "vsphere_usage_samples_vsphere_connection_id_fkey"
    FOREIGN KEY ("vsphere_connection_id") REFERENCES "vsphere_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
