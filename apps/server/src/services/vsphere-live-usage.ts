import type { LiveUsage, LiveUsageStaleReason } from '@lcm/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

import type { CollectedInventory } from './vsphere-inventory.js';

/** The poll cadence. ESXi samples its own counters every ~20s, so nothing here is truly live. */
export const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 2× the poll interval, so ONE missed poll does not flap the UI between fresh and
 * stale. Hysteresis, not slop.
 */
const FRESH_WINDOW_MS = 2 * POLL_INTERVAL_MS;

/**
 * Live memory usage: polled, cached, served (#179, epic #172).
 *
 * @ai-warning Request handlers read the CACHE and never await vCenter. That is a
 * property of the topology, not of careful coding: there is no code path from an
 * API response to a vCenter socket, so a total vCenter outage cannot add a
 * millisecond of latency to any request. Do not "just fetch it live if the cache is
 * stale" — that single line would undo it.
 */
export class VsphereLiveUsageService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Record a poll's readings.
   *
   * @ai-warning Only hosts that are actually reporting are summed, and
   * `hostsSampled`/`hostsTotal` carry the difference. Treating a disconnected host
   * as 0 GiB would look like consumption genuinely dropped — which in a capacity
   * tool reads as "we freed up memory", the opposite of the truth.
   */
  async record(
    connectionId: string,
    inventory: CollectedInventory,
    measuredAt: Date,
  ): Promise<number> {
    let written = 0;
    for (const collected of inventory.clusters) {
      const cluster = await this.prisma.cluster.findUnique({
        where: { connectionId_externalId: { connectionId, externalId: collected.moref } },
        select: { id: true },
      });
      if (!cluster) continue;

      const reporting = collected.hosts.filter((h) => h.connected && h.usageGiB !== null);
      const used = reporting.reduce((sum, h) => sum + (h.usageGiB ?? 0), 0);

      await this.prisma.vsphereUsageSample.upsert({
        where: { clusterId: cluster.id },
        create: {
          clusterId: cluster.id,
          connectionId,
          memoryUsedGiB: new Prisma.Decimal(used.toFixed(3)),
          hostsSampled: reporting.length,
          hostsTotal: collected.hosts.length,
          measuredAt,
        },
        update: {
          memoryUsedGiB: new Prisma.Decimal(used.toFixed(3)),
          hostsSampled: reporting.length,
          hostsTotal: collected.hosts.length,
          measuredAt,
        },
      });
      written += 1;
    }
    return written;
  }

  /**
   * The live reading for a cluster, as the API serves it.
   *
   * @ai-warning Staleness is computed HERE, server-side — never handed to the
   * client as a raw timestamp to judge. One source of truth, and no clock-skew
   * disagreement between a browser and the server.
   */
  async forCluster(clusterId: string, now: Date): Promise<LiveUsage | null> {
    const sample = await this.prisma.vsphereUsageSample.findUnique({
      where: { clusterId },
      include: { connection: { select: { name: true, enabled: true, status: true } } },
    });

    // No sample yet. `null` rather than a zeroed reading: the caller renders
    // `never_fetched`, which structurally cannot carry numbers. Returning
    // `{ used: 0 }` here would be the whole bug this design exists to prevent.
    if (!sample) return null;

    const ageSeconds = Math.max(
      0,
      Math.floor((now.getTime() - sample.measuredAt.getTime()) / 1000),
    );
    const base = {
      clusterId,
      connectionName: sample.connection.name,
      memoryUsedGiB: sample.memoryUsedGiB.toNumber(),
      hostsSampled: sample.hostsSampled,
      hostsTotal: sample.hostsTotal,
      measuredAt: sample.measuredAt.toISOString(),
      ageSeconds,
    };

    const reason = staleReason(sample.connection, now.getTime() - sample.measuredAt.getTime());
    if (reason) return { state: 'stale', ...base, reason };
    return { state: 'fresh', ...base };
  }

  /** A cluster with no sample yet. Structurally carries no numbers — see the contract. */
  neverFetched(clusterId: string, connectionName: string): LiveUsage {
    return { state: 'never_fetched', clusterId, connectionName };
  }
}

function staleReason(
  connection: { enabled: boolean; status: string },
  ageMs: number,
): LiveUsageStaleReason | null {
  // An operator's choice is not a fault, but the reading is still not live.
  if (!connection.enabled) return 'disabled';
  if (connection.status === 'auth_failed') return 'auth_failed';
  if (connection.status === 'tls_untrusted' || connection.status === 'cert_mismatch') {
    return 'tls_untrusted';
  }
  if (connection.status === 'identity_mismatch') return 'identity_mismatch';
  if (ageMs > FRESH_WINDOW_MS) return 'unreachable';
  return null;
}
