-- Time-scoped host↔cluster membership (#289).
--
-- ADDITIVE ONLY. A new table plus a one-open-row-per-host backfill; nothing is
-- dropped or rewritten, so rolling `LCM_IMAGE_TAG` back to the previous image
-- stays safe indefinitely — the old code ignores this table and reads
-- `hosts.cluster_id`, which the new code keeps equal to the open membership.
--
-- Owner decision (2026-07-22): a host move is TIME-SCOPED, not a `cluster_id`
-- flip. The forecast attributes a host's capacity to the OLD cluster before the
-- move and the NEW cluster on/after it, resolving the covering interval per
-- modelled month (services/forecast-loader.ts + forecast.ts). Capacity rows stay
-- FK'd to `host_id`; none are moved.

-- CreateTable
CREATE TABLE "host_cluster_memberships" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "host_id" TEXT NOT NULL,
    "cluster_id" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "host_cluster_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "host_cluster_memberships_host_id_idx" ON "host_cluster_memberships"("host_id");

-- CreateIndex
CREATE INDEX "host_cluster_memberships_cluster_id_idx" ON "host_cluster_memberships"("cluster_id");

-- CreateIndex
CREATE INDEX "host_cluster_memberships_tenant_id_cluster_id_idx" ON "host_cluster_memberships"("tenant_id", "cluster_id");

-- AddForeignKey
ALTER TABLE "host_cluster_memberships" ADD CONSTRAINT "host_cluster_memberships_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_cluster_memberships" ADD CONSTRAINT "host_cluster_memberships_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_cluster_memberships" ADD CONSTRAINT "host_cluster_memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- BACKFILL. Every existing host gets EXACTLY ONE open membership
-- (`effective_to = NULL`) starting at its `commissioned_at`, in its current
-- `cluster_id`. This is what makes the migration provably behaviour-preserving:
-- `effectiveCapacityAt` already returns 0 before `commissioned_at`, and the
-- interval covers the host's entire active life in that one cluster, so every
-- month's attribution is identical to today's `cluster.hosts`-by-`cluster_id`
-- read. Divergence can only begin with a FUTURE move — never retroactively.
--
-- gen_random_uuid() supplies the surrogate key because Prisma's cuid() is
-- generated client-side and is unavailable here (same as the baseline-history
-- backfill). The column is opaque — nothing parses it — so the mixed cuid/uuid
-- formats are harmless.
INSERT INTO "host_cluster_memberships" (
    "id", "tenant_id", "host_id", "cluster_id", "effective_from", "effective_to"
)
SELECT
    gen_random_uuid()::text,
    h."tenant_id",
    h."id",
    h."cluster_id",
    h."commissioned_at",
    NULL
FROM "hosts" h;

-- Fail the migration rather than start Fastify on a partial backfill. Each
-- Prisma migration runs in a transaction, so raising here rolls the whole thing
-- back atomically and the container entrypoint's `prisma migrate deploy` exits
-- non-zero — the server never boots, serving nothing rather than serving wrong
-- forecast numbers. That is the intended failure mode for purchasing-critical
-- data. Invariant: exactly one membership row per host after backfill, all open.
DO $$
DECLARE
    host_count BIGINT;
    membership_count BIGINT;
    open_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO host_count FROM "hosts";
    SELECT COUNT(*) INTO membership_count FROM "host_cluster_memberships";
    SELECT COUNT(*) INTO open_count FROM "host_cluster_memberships" WHERE "effective_to" IS NULL;
    IF host_count <> membership_count OR host_count <> open_count THEN
        RAISE EXCEPTION
            'Host membership backfill incomplete: % hosts produced % memberships (% open). Refusing to proceed.',
            host_count, membership_count, open_count;
    END IF;
END $$;
