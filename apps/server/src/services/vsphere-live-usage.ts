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

    return reading(clusterId, sample, sample.connection, now);
  }

  /**
   * Live usage for every SYNCED cluster in the tenant, in one query — the fleet
   * console renders N tiles and would otherwise issue N round-trips (D24/#193).
   *
   * @ai-warning Manual clusters (no `connectionId`) are ABSENT from the result,
   * never `never_fetched`: `never_fetched` requires a `connectionName` a manual
   * cluster does not have, and absence is the honest encoding of "no vCenter is
   * involved here". A synced cluster with no sample maps to `never_fetched`, so
   * the returned array is `LiveUsage[]` — never contains a `null` — and no
   * caller can coalesce a missing reading into a 0.
   *
   * Reads the Postgres cache only; there is no path from here to a vCenter
   * socket (D25). Archived clusters are excluded, matching the default fleet
   * view.
   */
  async listForTenant(tenantId: string, now: Date): Promise<LiveUsage[]> {
    const clusters = await this.prisma.cluster.findMany({
      where: { tenantId, connectionId: { not: null }, archivedAt: null },
      select: {
        id: true,
        connection: { select: { name: true, enabled: true, status: true } },
        usageSample: true,
      },
      orderBy: { name: 'asc' },
    });

    const items: LiveUsage[] = [];
    for (const cluster of clusters) {
      // `connectionId` is non-null by the query filter, so the relation is
      // present; the guard narrows the type rather than handling an expected case.
      if (!cluster.connection) continue;
      if (!cluster.usageSample) {
        items.push(this.neverFetched(cluster.id, cluster.connection.name));
        continue;
      }
      items.push(reading(cluster.id, cluster.usageSample, cluster.connection, now));
    }
    return items;
  }

  /** A cluster with no sample yet. Structurally carries no numbers — see the contract. */
  neverFetched(clusterId: string, connectionName: string): LiveUsage {
    return { state: 'never_fetched', clusterId, connectionName };
  }
}

/**
 * Build a `fresh`/`stale` reading from a cached sample. Shared by the
 * single-cluster and batch reads so staleness is computed one way, server-side.
 */
function reading(
  clusterId: string,
  sample: {
    memoryUsedGiB: Prisma.Decimal;
    hostsSampled: number;
    hostsTotal: number;
    measuredAt: Date;
  },
  connection: { name: string; enabled: boolean; status: string },
  now: Date,
): LiveUsage {
  const ageMs = now.getTime() - sample.measuredAt.getTime();
  const base = {
    clusterId,
    connectionName: connection.name,
    memoryUsedGiB: sample.memoryUsedGiB.toNumber(),
    hostsSampled: sample.hostsSampled,
    hostsTotal: sample.hostsTotal,
    measuredAt: sample.measuredAt.toISOString(),
    ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
  };
  const reason = staleReason(connection, ageMs);
  if (reason) return { state: 'stale', ...base, reason };
  return { state: 'fresh', ...base };
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
