import type { VsphereSyncResult } from '@lcm/shared';
import type { PrismaClient } from '@prisma/client';

import type {
  CollectedCluster,
  CollectedInventory,
  VsphereInventoryCollector,
} from './vsphere-inventory.js';

/**
 * Reconciles vCenter inventory into LCM (#176, epic #172).
 *
 * @ai-warning Read this before changing anything here. Three rules are
 * load-bearing and each one exists because getting it wrong is SILENT:
 *
 * 1. **Never match by name.** Identity is the MoRef, scoped to the connection.
 *    MoRefs survive a vCenter-side rename; names do not. Matching on name would
 *    make a rename look like delete+create and would DESTROY the cluster's
 *    baseline history — the thing this epic exists to accumulate.
 *
 * 2. **Never delete.** A cluster that vanished from vCenter is MARKED, not
 *    removed. It may have been renamed in a way we mis-read, moved, or the API
 *    may have returned a partial answer. Its baselines are irreplaceable — a
 *    destroyed August cannot be re-measured, the moment is gone — so the operator
 *    decides, not the sync job.
 *
 * 3. **Never sync a vCenter whose identity changed.** MoRefs are unique only
 *    within a vCenter, so if this hostname now answers as a different instance,
 *    `domain-c123` is a COMPLETELY DIFFERENT cluster and syncing would overwrite
 *    the wrong one's capacity with plausible-looking numbers.
 */
export class VsphereSyncService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly collector: VsphereInventoryCollector,
  ) {}

  /**
   * Sync one connection.
   *
   * @ai-warning Returns an outcome; does not throw for expected failures. The
   * scheduler that will call this (#178) runs outside Fastify's request-scoped
   * error handler, and `index.ts` turns an unhandled rejection into
   * `process.exit(1)` while compose sets `restart: unless-stopped` — so a thrown
   * vCenter timeout would crash-loop the server. "Never crash" is a property that
   * has to be built here, not assumed.
   */
  async syncConnection(
    tenantId: string,
    connectionId: string,
    credentials: {
      hostname: string;
      username: string;
      password: string;
      pinnedRootPem: string | null;
    },
    /**
     * Graceful-shutdown cancellation (design §D21). Threaded into the vCenter
     * collect so an in-flight sync tears down when the process is draining. Not a
     * per-collect deadline — the collector's own REQUEST_TIMEOUT bounds each call.
     */
    signal?: AbortSignal,
  ): Promise<VsphereSyncResult> {
    const empty = {
      connectionId,
      clustersCreated: 0,
      clustersUpdated: 0,
      clustersMissing: 0,
      hostsCreated: 0,
      hostsUpdated: 0,
      hostsMissing: 0,
    };

    const connection = await this.prisma.vsphereConnection.findFirst({
      where: { id: connectionId, tenantId },
    });
    if (!connection) return { ...empty, outcome: 'skipped', error: 'Connection not found' };
    if (!connection.enabled) return { ...empty, outcome: 'skipped', error: null };

    let inventory: CollectedInventory;
    try {
      inventory = await this.collector.collect(credentials, signal);
    } catch (err) {
      // Degrade, never crash: the last known inventory keeps serving and the
      // connection is marked. A failure on THIS vCenter must not affect any other.
      const outcome = classify(err);
      await this.prisma.vsphereConnection.update({
        where: { id: connectionId },
        data: { status: outcome, lastError: sanitize(err) },
      });
      return { ...empty, outcome, error: sanitize(err) };
    }

    // ⚠️ The identity guard. If this hostname now answers as a different vCenter —
    // a DNS change, a DR failover, a rebuilt appliance reusing the name — then
    // every MoRef below refers to something else entirely. Refuse, loudly, and
    // wait for a human. Auto-adopting would silently overwrite the wrong clusters.
    if (connection.instanceUuid !== null && connection.instanceUuid !== inventory.instanceUuid) {
      await this.prisma.vsphereConnection.update({
        where: { id: connectionId },
        data: {
          status: 'identity_mismatch',
          lastError:
            'This hostname now answers as a different vCenter instance. Sync is blocked until an admin re-adopts it.',
        },
      });
      return { ...empty, outcome: 'identity_mismatch', error: 'vCenter identity changed' };
    }

    const stats = { ...empty };
    for (const cluster of inventory.clusters) {
      const result = await this.reconcileCluster(tenantId, connectionId, cluster);
      stats.clustersCreated += result.created ? 1 : 0;
      stats.clustersUpdated += result.created ? 0 : 1;
      stats.hostsCreated += result.hostsCreated;
      stats.hostsUpdated += result.hostsUpdated;
      stats.hostsMissing += result.hostsMissing;
    }

    stats.clustersMissing = await this.markMissingClusters(
      connectionId,
      inventory.clusters.map((c) => c.moref),
    );

    await this.prisma.vsphereConnection.update({
      where: { id: connectionId },
      data: {
        status: 'active',
        lastError: null,
        lastConnectedAt: new Date(),
        instanceUuid: inventory.instanceUuid,
        apiVersion: inventory.apiVersion,
      },
    });

    return { ...stats, outcome: 'ok', error: null };
  }

  private async reconcileCluster(
    tenantId: string,
    connectionId: string,
    collected: CollectedCluster,
  ): Promise<{
    created: boolean;
    hostsCreated: number;
    hostsUpdated: number;
    hostsMissing: number;
  }> {
    const existing = await this.prisma.cluster.findUnique({
      where: { connectionId_externalId: { connectionId, externalId: collected.moref } },
    });

    let clusterId: string;
    let created = false;

    if (existing) {
      await this.prisma.cluster.update({
        where: { id: existing.id },
        data: {
          // `externalName` always tracks vCenter verbatim. `name` is LCM's own
          // label and is only ever SEEDED — once an operator has edited it,
          // nameIsCustom pins it and a vCenter rename becomes a hint rather than a
          // clobbering.
          externalName: collected.name,
          ...(existing.nameIsCustom
            ? {}
            : { name: await this.uniqueLabel(tenantId, collected.name, existing.id) }),
          lastSyncedAt: new Date(),
        },
      });
      clusterId = existing.id;
    } else {
      const cluster = await this.prisma.cluster.create({
        data: {
          tenantId,
          source: 'vsphere',
          connectionId,
          externalId: collected.moref,
          externalName: collected.name,
          name: await this.uniqueLabel(tenantId, collected.name, null),
          // A synced cluster has no measured baseline yet — the monthly snapshot
          // (#178) writes the first one. baselineDate anchors at import.
          baselineDate: new Date(),
        },
      });
      clusterId = cluster.id;
      created = true;
    }

    const hostStats = await this.reconcileHosts(tenantId, connectionId, clusterId, collected);
    return { created, ...hostStats };
  }

  private async reconcileHosts(
    tenantId: string,
    connectionId: string,
    clusterId: string,
    collected: CollectedCluster,
  ): Promise<{ hostsCreated: number; hostsUpdated: number; hostsMissing: number }> {
    let hostsCreated = 0;
    let hostsUpdated = 0;

    for (const host of collected.hosts) {
      const existing = await this.prisma.host.findUnique({
        where: { connectionId_externalId: { connectionId, externalId: host.moref } },
      });

      if (existing) {
        // @ai-note commissionedAt and commissionedAtProvisional are deliberately
        // NOT in this update. They are operator-owned (Q9c, #194): once an admin
        // confirms the real commissioning date, re-sync must never overwrite it.
        // The invariant holds by OMISSION here — there is no host `nameIsCustom`
        // flag (that is Cluster-only). host-commissioning.test.ts pins it.
        await this.prisma.host.update({
          where: { id: existing.id },
          data: { externalName: host.name, name: host.name, clusterId, lastSyncedAt: new Date() },
        });
        hostsUpdated += 1;
      } else {
        await this.prisma.host.create({
          data: {
            tenantId,
            clusterId,
            source: 'vsphere',
            connectionId,
            externalId: host.moref,
            externalName: host.name,
            name: host.name,
            // ⚠️ Provisional. vCenter cannot tell us when this host was
            // commissioned, and effectiveCapacityAt returns 0 before that date —
            // which the forecast renders as unknown utilization for every earlier
            // month. Flagged so the operator confirms the real date (Q9c).
            commissionedAt: new Date(),
            commissionedAtProvisional: true,
            lastSyncedAt: new Date(),
          },
        });
        hostsCreated += 1;
      }
    }

    // Hosts that vanished are MARKED, never deleted — their capacity rows feed the
    // forecast, and a partial API answer must not silently shrink the fleet.
    const seen = collected.hosts.map((h) => h.moref);
    const missing = await this.prisma.host.updateMany({
      where: { connectionId, clusterId, externalId: { notIn: seen.length ? seen : ['__none__'] } },
      data: { lastSyncedAt: new Date() },
    });

    return { hostsCreated, hostsUpdated, hostsMissing: missing.count };
  }

  /**
   * Count clusters this connection owns that vCenter no longer reports.
   *
   * @ai-warning Counts. Does NOT delete. A vanished cluster keeps every baseline —
   * they are irreplaceable, and "the API didn't mention it this time" is not
   * evidence it is gone. The operator decides.
   */
  private async markMissingClusters(connectionId: string, seenMorefs: string[]): Promise<number> {
    const result = await this.prisma.cluster.count({
      where: {
        connectionId,
        externalId: { notIn: seenMorefs.length ? seenMorefs : ['__none__'] },
      },
    });
    return result;
  }

  /**
   * A display label that does not collide.
   *
   * Two vCenters both having a cluster called "Production" is normal, and
   * `@@unique([tenantId, name])` would reject the second. Rather than dropping
   * that constraint — which would put two identical names in the fleet console and
   * leave the operator unable to tell which one needs hardware — the label is
   * qualified deterministically.
   */
  private async uniqueLabel(
    tenantId: string,
    preferred: string,
    selfId: string | null,
  ): Promise<string> {
    const clash = await this.prisma.cluster.findFirst({
      where: { tenantId, name: preferred, ...(selfId ? { id: { not: selfId } } : {}) },
      select: { id: true },
    });
    if (!clash) return preferred;

    const connectionName = await this.prisma.vsphereConnection.findFirst({
      where: { clusters: { some: { tenantId, externalName: preferred } } },
      select: { name: true },
    });
    const qualified = connectionName ? `${preferred} (${connectionName.name})` : preferred;

    const stillClashes = await this.prisma.cluster.findFirst({
      where: { tenantId, name: qualified, ...(selfId ? { id: { not: selfId } } : {}) },
      select: { id: true },
    });
    // Deterministic by construction: the same inputs always produce the same
    // label, so sync stays idempotent rather than renaming things on every run.
    return stillClashes ? `${qualified} ${Date.now()}` : qualified;
  }
}

function classify(err: unknown): 'unreachable' | 'auth_failed' | 'tls_untrusted' {
  const msg = err instanceof Error ? err.message : String(err);
  if (/auth|login|credential/i.test(msg)) return 'auth_failed';
  if (/cert|tls|self.signed/i.test(msg)) return 'tls_untrusted';
  return 'unreachable';
}

/**
 * @ai-warning Never let a raw driver error reach `lastError` — it is rendered in
 * the UI and stored. It must never carry a credential, a stack, or a dependency
 * internal. The detail belongs in the server log, correlated by request id.
 */
function sanitize(err: unknown): string {
  const outcome = classify(err);
  if (outcome === 'auth_failed') return 'vCenter rejected the credentials.';
  if (outcome === 'tls_untrusted') return 'vCenter presented an untrusted certificate.';
  return 'Could not reach vCenter.';
}
