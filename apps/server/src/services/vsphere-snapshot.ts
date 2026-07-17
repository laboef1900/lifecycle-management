import { startOfUtcMonth } from '@lcm/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

import type { CollectedInventory, VsphereInventoryCollector } from './vsphere-inventory.js';
import { VsphereSyncService } from './vsphere-sync.js';

/**
 * Appends a measured baseline per synced cluster (#178, epic #172).
 *
 * @ai-warning `baselineCapacity` is written as **0** for synced clusters, and that
 * is not a placeholder. `forecast.ts` treats `baselineCapacity` as an OFFSET and
 * *adds* every tracked host's capacity to it, so writing the measured fleet
 * capacity here while sync also imports each host's real memory would give
 * `capacity = fleet + fleet` — utilization halved, "plenty of headroom", and
 * hardware never ordered. That is the exact outage LCM exists to prevent, and it
 * would look entirely plausible. Recorded decision Q9a; see docs/vision.md
 * "Forecast modelling semantics".
 *
 * The invariant, stated once: **`baseline*` is the portion NOT modelled by tracked
 * entities.** vCenter gives authoritative per-host capacity, so for a synced
 * cluster the hosts ARE the capacity and the scalar must be zero.
 */
export class VsphereSnapshotService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly collector: VsphereInventoryCollector,
  ) {}

  /**
   * Sync inventory, then measure and append one baseline per synced cluster.
   *
   * @ai-warning The ordering is not incidental and must not be relaxed into "the
   * 6-hourly sync probably ran recently". The snapshot's capacity denominator has
   * to reflect the hosts that exist *now*: a baseline with a stale denominator is
   * **worse than a missing one** — it is a plausible lie that silently biases
   * purchasing, where a gap is merely visible. The line is: we never write a
   * baseline we cannot stand behind.
   *
   * Throws on failure. The scheduler owns all error handling and the backoff that
   * keeps the job inside its month.
   */
  async runSnapshot(
    tenantId: string,
    connectionId: string,
    credentials: {
      hostname: string;
      username: string;
      password: string;
      pinnedRootPem: string | null;
    },
    measuredAt: Date,
  ): Promise<{ snapshotPeriod: Date | null; clustersSnapshotted: number }> {
    // 1. Sync first, always. A sync failure aborts THIS connection's snapshot
    //    deliberately — see the docstring.
    const sync = new VsphereSyncService(this.prisma, this.collector);
    const syncResult = await sync.syncConnection(tenantId, connectionId, credentials);
    if (syncResult.outcome !== 'ok') {
      throw new Error(`sync ${syncResult.outcome}: ${syncResult.error ?? 'unknown'}`);
    }

    // 2. Measure. A second collect is deliberate: usage moves, inventory does not,
    //    and the numbers must describe the fleet we just reconciled.
    const inventory = await this.collector.collect(credentials);
    const metric = await this.prisma.metricType.findUniqueOrThrow({ where: { key: 'memory_gb' } });

    // ⚠️ The period comes from the MEASUREMENT clock, never from a schedule. A
    // retry on 3 August still writes 2026-08-01, which is what makes the unique
    // constraint (clusterId, metricTypeId, capturedAt) *be* monthly idempotency
    // rather than something application code has to remember.
    const period = startOfUtcMonth(measuredAt);
    let clustersSnapshotted = 0;

    for (const collected of inventory.clusters) {
      const cluster = await this.prisma.cluster.findUnique({
        where: { connectionId_externalId: { connectionId, externalId: collected.moref } },
        select: { id: true },
      });
      if (!cluster) continue;

      // Only hosts that are actually reporting contribute. A host in maintenance
      // or disconnected has no usage to measure, and counting it as 0 would look
      // like consumption dropped.
      const reporting = collected.hosts.filter((h) => h.connected && h.usageGiB !== null);
      if (reporting.length === 0) continue;
      const consumption = reporting.reduce((sum, h) => sum + (h.usageGiB ?? 0), 0);

      // ⚠️ ON CONFLICT DO NOTHING, not upsert. The history is append-only, and a
      // re-run within the same month must be a no-op rather than a rewrite: if a
      // human has corrected this period, their correction wins. `createMany` with
      // skipDuplicates lets POSTGRES enforce that via the period unique index —
      // the guard cannot be forgotten by application code, and it holds under the
      // concurrency it exists to prevent.
      const written = await this.prisma.clusterBaselineHistory.createMany({
        data: [
          {
            clusterId: cluster.id,
            tenantId,
            metricTypeId: metric.id,
            capturedAt: period,
            source: 'vsphere',
            observedAt: measuredAt,
            baselineConsumption: new Prisma.Decimal(consumption.toFixed(3)),
            // See the class docstring. NOT the measured capacity — the synced
            // hosts carry it, and adding both double-counts.
            baselineCapacity: new Prisma.Decimal(0),
          },
        ],
        skipDuplicates: true,
      });
      clustersSnapshotted += written.count;
    }

    return { snapshotPeriod: period, clustersSnapshotted };
  }
}

/** Re-exported for the job wiring; keeps the import surface obvious. */
export type { CollectedInventory, VsphereInventoryCollector };
