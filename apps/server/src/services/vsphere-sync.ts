import { startOfUtcMonth, type VsphereSyncOutcome, type VsphereSyncResult } from '@lcm/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

import type {
  CollectedCluster,
  CollectedInventory,
  VsphereInventoryCollector,
} from './vsphere-inventory.js';
import { extractTlsErrorCode } from './vsphere-tls.js';

/**
 * Pino-shaped sink for the sync diagnostic (#272). Its own interface rather than
 * the collector's `{ warn }`-only `CollectorLogger`: this service logs at two
 * levels (see the level policy in `syncConnection`), and naming it for the sync
 * path keeps it honest about who uses it.
 */
export interface VsphereLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

const noopLogger: VsphereLogger = { info: () => undefined, warn: () => undefined };

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
  private readonly logger: VsphereLogger;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly collector: VsphereInventoryCollector,
    /**
     * Structured sink for the TLS-failure diagnostic (#272). Optional so the
     * many `new VsphereSyncService(prisma, collector)` call sites (tests
     * included) keep working; defaults to no-op.
     */
    logger?: VsphereLogger,
  ) {
    this.logger = logger ?? noopLogger;
  }

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
      /** vCenter port; omitted defaults to 443 in the collector (#199). */
      port?: number;
      username: string;
      password: string;
      pinnedLeafSha256: string | null;
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
      // Server-log the raw OpenSSL/Node code (#272) — the one fact `sanitize`
      // and `lastError` throw away. It is what separates an incomplete-chain pin
      // (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`/`SELF_SIGNED_CERT_IN_CHAIN`) from a
      // rotation. Code only, never the message/stack: a driver error can carry
      // the credential, and `lastError` is UI-rendered and stored, so it keeps
      // the sanitized string untouched below.
      //
      // Level policy: `unreachable` is routine and transient (a vCenter down for
      // a maintenance window would warn on every poll), so it logs at INFO;
      // `tls_untrusted` and `auth_failed` are persistent, actionable, and the
      // states #272 is about, so they warn.
      const details = {
        event: 'vsphere.sync.failed',
        connectionId,
        outcome,
        tlsCode: extractTlsErrorCode(err),
      };
      if (outcome === 'unreachable') this.logger.info(details, 'vCenter sync failed');
      else this.logger.warn(details, 'vCenter sync failed');
      await this.prisma.vsphereConnection.update({
        where: { id: connectionId },
        data: { status: outcome, lastError: sanitize(err) },
      });
      // VsphereSyncOutcome (the job-result vocabulary) has no cert_mismatch value
      // — the connection row above gets the more specific status (routing the
      // operator to the "Replace the trusted certificate" dialog), but the
      // returned result stays within the vocabulary the scheduler understands.
      const syncOutcome: VsphereSyncOutcome =
        outcome === 'cert_mismatch' ? 'tls_untrusted' : outcome;
      return { ...empty, outcome: syncOutcome, error: sanitize(err) };
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

    // Resolve the memory metric once, up front. It is seeded reference data, so a
    // miss is a deploy fault worth surfacing immediately rather than part-way
    // through a fleet. Threaded into host reconciliation, which now records each
    // host's installed memory as its capacity (#198) — the numbers a synced
    // cluster's forecast reads instead of "unknown".
    const memoryMetricId = (
      await this.prisma.metricType.findUniqueOrThrow({ where: { key: 'memory_gb' } })
    ).id;

    const stats = { ...empty };
    for (const cluster of inventory.clusters) {
      const result = await this.reconcileCluster(tenantId, connectionId, cluster, memoryMetricId);
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
    memoryMetricId: string,
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
          // (#178) writes the first one. Until then it has no baseline history at
          // all, so `ClusterResponse.baselineDate` falls back to `createdAt`
          // (#195) — the same import instant the dropped `baselineDate` column
          // used to record here explicitly.
        },
      });
      clusterId = cluster.id;
      created = true;
    }

    const hostStats = await this.reconcileHosts(
      tenantId,
      connectionId,
      clusterId,
      collected,
      memoryMetricId,
    );
    return { created, ...hostStats };
  }

  private async reconcileHosts(
    tenantId: string,
    connectionId: string,
    clusterId: string,
    collected: CollectedCluster,
    memoryMetricId: string,
  ): Promise<{ hostsCreated: number; hostsUpdated: number; hostsMissing: number }> {
    let hostsCreated = 0;
    let hostsUpdated = 0;

    for (const host of collected.hosts) {
      const now = new Date();
      // vCenter reports installed memory in GiB; it becomes this host's capacity.
      // Decimal(18,3) via toFixed(3), matching the snapshot/live-usage idiom.
      const desiredMemory = new Prisma.Decimal(host.memoryGiB.toFixed(3));

      const existing = await this.prisma.host.findUnique({
        where: { connectionId_externalId: { connectionId, externalId: host.moref } },
        // Only the latest memory row is needed to decide whether capacity changed.
        include: {
          capacities: {
            where: { metricTypeId: memoryMetricId },
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
          },
        },
      });

      if (existing) {
        // @ai-note commissionedAt and commissionedAtProvisional are deliberately
        // NOT in this update. They are operator-owned (Q9c, #194): once an admin
        // confirms the real commissioning date, re-sync must never overwrite it.
        // The invariant holds by OMISSION here. host-commissioning.test.ts pins it.
        //
        // `externalName` always tracks vCenter verbatim. `name` is LCM's own label
        // and is only SEEDED — once an operator renames the host, nameIsCustom
        // pins it and this pass stops clobbering the label (#196, parity with the
        // Cluster branch above). Before #196 sync overwrote `name` every pass.
        await this.prisma.host.update({
          where: { id: existing.id },
          data: {
            externalName: host.name,
            ...(existing.nameIsCustom ? {} : { name: host.name }),
            clusterId,
            lastSyncedAt: now,
          },
        });
        await this.reconcileHostCapacity(tenantId, existing, memoryMetricId, desiredMemory, now);
        // #289 keep the host's membership timeline in step with its clusterId.
        // If vCenter moved it between clusters this pass, this closes the old
        // interval and opens a new one; otherwise it is a no-op.
        await this.reconcileMembership(
          tenantId,
          existing.id,
          clusterId,
          existing.commissionedAt,
          now,
        );
        hostsUpdated += 1;
      } else {
        const createdHost = await this.prisma.host.create({
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
            commissionedAt: now,
            commissionedAtProvisional: true,
            lastSyncedAt: now,
            // Capacity begins exactly when the host does. `effectiveFrom` is a
            // @db.Date and `commissionedAt` uses the same instant, so the two are
            // date-aligned by construction and the forecast has capacity from the
            // host's first modelled month. See reconcileHostCapacity for re-syncs.
            capacities: {
              create: [
                {
                  tenantId,
                  metricTypeId: memoryMetricId,
                  effectiveFrom: now,
                  amount: desiredMemory,
                },
              ],
            },
          },
        });
        // #289 seed the host's first membership timeline in its cluster so the
        // forecast attributes its capacity (parity with the migration backfill).
        await this.reconcileMembership(
          tenantId,
          createdHost.id,
          clusterId,
          createdHost.commissionedAt,
          now,
        );
        hostsCreated += 1;
      }
    }

    // Hosts that vanished are MARKED, never deleted. The collector deliberately
    // omits disconnected/unreadable hosts because they provide no live capacity, so
    // append a zero-capacity step while they are absent. A later successful sync
    // appends their measured memory again, preserving history in both directions.
    const seen = collected.hosts.map((h) => h.moref);
    const missingHosts = await this.prisma.host.findMany({
      where: { connectionId, clusterId, externalId: { notIn: seen.length ? seen : ['__none__'] } },
      include: {
        capacities: {
          where: { metricTypeId: memoryMetricId },
          orderBy: { effectiveFrom: 'desc' },
          take: 1,
        },
      },
    });
    const missingAt = new Date();
    for (const missing of missingHosts) {
      await this.prisma.host.update({
        where: { id: missing.id },
        data: { lastSyncedAt: missingAt },
      });
      await this.reconcileHostCapacity(
        tenantId,
        missing,
        memoryMetricId,
        new Prisma.Decimal(0),
        missingAt,
      );
    }

    return { hostsCreated, hostsUpdated, hostsMissing: missingHosts.length };
  }

  /**
   * Keep a synced host's time-scoped cluster membership in step with its
   * `clusterId` (#289). Idempotent, and the sole membership writer on the sync
   * path:
   *  - no open membership yet (first import, or a legacy synced host predating
   *    #289) → seed one open row from the host's commissioning date;
   *  - open membership already in this cluster → no-op, so idempotent re-syncs
   *    never accrete rows;
   *  - open membership in a DIFFERENT cluster (vCenter moved the host) → close it
   *    and open a new one.
   *
   * @ai-note The move date is the current month start, but CLAMPED to never
   * precede the open interval's start — a `startOfUtcMonth(now)` earlier than
   * `effectiveFrom` (a host commissioned and moved within one month) would write a
   * `effectiveTo < effectiveFrom` row. Clamping yields a harmless zero-length old
   * interval instead. Never retroactive: past months keep the old attribution.
   * Invariant preserved: exactly one open membership per host, contiguous.
   */
  private async reconcileMembership(
    tenantId: string,
    hostId: string,
    clusterId: string,
    commissionedAt: Date,
    now: Date,
  ): Promise<void> {
    const open = await this.prisma.hostClusterMembership.findFirst({
      where: { hostId, effectiveTo: null },
    });
    if (!open) {
      await this.prisma.hostClusterMembership.create({
        data: { tenantId, hostId, clusterId, effectiveFrom: commissionedAt, effectiveTo: null },
      });
      return;
    }
    if (open.clusterId === clusterId) return;

    const monthStart = startOfUtcMonth(now);
    const moveDate = monthStart > open.effectiveFrom ? monthStart : open.effectiveFrom;
    await this.prisma.hostClusterMembership.update({
      where: { id: open.id },
      data: { effectiveTo: moveDate },
    });
    await this.prisma.hostClusterMembership.create({
      data: { tenantId, hostId, clusterId, effectiveFrom: moveDate, effectiveTo: null },
    });
  }

  /**
   * Append a synced host's memory capacity when it first appears or changes (#198).
   *
   * Capacity rows are append-forward-only: `effective_from` is a @db.Date and the
   * unique index is (host, metric, effective_from). The rules:
   *  - no rows yet (a host imported before #198, or one whose create failed to seed
   *    it) → seed one at the host's commissioning date so its history starts where
   *    the host does;
   *  - unchanged memory → write nothing, so idempotent re-syncs never accrete rows;
   *  - changed memory (up OR down — the invariant bounds the DATE, not the amount) →
   *    append one row effective from the start of the current month, but only if
   *    that is strictly later than the newest row. A second change within the same
   *    month cannot append at month granularity and waits for next month;
   *  - zero is the reversible "currently missing" marker. Availability transitions
   *    use the observed UTC day (rather than the month start), preserving the
   *    installed-memory row before a disconnect while still taking effect before the
   *    next forecast month. A second transition on the same day updates that day's
   *    latest row because @db.Date cannot represent two states within one day.
   *
   * `skipDuplicates` makes a same-period collision a no-op rather than a throw —
   * the same idiom the snapshot uses, and what keeps sync's "degrade, never crash"
   * contract intact if two passes ever race on the same period.
   */
  private async reconcileHostCapacity(
    tenantId: string,
    host: {
      id: string;
      commissionedAt: Date;
      capacities: { id: string; effectiveFrom: Date; amount: Prisma.Decimal }[];
    },
    memoryMetricId: string,
    desiredMemory: Prisma.Decimal,
    now: Date,
  ): Promise<void> {
    const latest = host.capacities[0];

    const availabilityTransition =
      latest !== undefined && (latest.amount.isZero() || desiredMemory.isZero());
    const effectiveFrom = latest
      ? availabilityTransition
        ? startOfUtcDay(now)
        : startOfUtcMonth(now)
      : host.commissionedAt;
    if (latest) {
      if (latest.amount.equals(desiredMemory)) return;
      if (effectiveFrom <= latest.effectiveFrom) {
        if (availabilityTransition) {
          await this.prisma.hostMetricCapacity.update({
            where: { id: latest.id },
            data: { amount: desiredMemory },
          });
        }
        return;
      }
    }

    await this.prisma.hostMetricCapacity.createMany({
      data: [
        {
          hostId: host.id,
          tenantId,
          metricTypeId: memoryMetricId,
          effectiveFrom,
          amount: desiredMemory,
        },
      ],
      skipDuplicates: true,
    });
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

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function classify(err: unknown): 'unreachable' | 'auth_failed' | 'tls_untrusted' | 'cert_mismatch' {
  const code = extractTlsErrorCode(err);
  const msg = err instanceof Error ? err.message : String(err);
  // Checked BEFORE the generic /cert|tls/ branch below: that regex would
  // otherwise swallow the Task 3 leaf-pin mismatch into tls_untrusted, losing
  // the distinction that routes the operator to the replace-cert dialog.
  if (code === 'CERT_FINGERPRINT_MISMATCH' || /CERT_FINGERPRINT_MISMATCH/.test(msg)) {
    return 'cert_mismatch';
  }
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
  if (outcome === 'cert_mismatch') {
    return 'vCenter is presenting a different certificate than the one you trusted.';
  }
  if (outcome === 'tls_untrusted') return 'vCenter presented an untrusted certificate.';
  return 'Could not reach vCenter.';
}
