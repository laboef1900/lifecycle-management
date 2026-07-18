import type { VsphereSyncOutcome, VsphereSyncResult } from '@lcm/shared';
import type { PrismaClient } from '@prisma/client';

import type { CollectedInventory, VsphereInventoryCollector } from './vsphere-inventory.js';
import {
  sanitizeJobError,
  type DueState,
  type JobRunner,
  type JobRunReport,
} from './vsphere-scheduler.js';

/** The credential bundle every vCenter call takes. Assembled per run, never cached. */
interface VsphereCredentials {
  hostname: string;
  port: number;
  username: string;
  password: string;
  pinnedRootPem: string | null;
}

/**
 * The narrow slices of each service the runner drives. Injected as interfaces (not
 * the concrete classes, whose private fields would block a test fake) so the D15a
 * dispatch is testable against spies.
 */
export interface JobRunnerServices {
  connections: { revealPassword(tenantId: string, id: string): Promise<string> };
  sync: {
    syncConnection(
      tenantId: string,
      connectionId: string,
      credentials: VsphereCredentials,
      signal?: AbortSignal,
    ): Promise<VsphereSyncResult>;
  };
  snapshot: {
    runSnapshot(
      tenantId: string,
      connectionId: string,
      credentials: VsphereCredentials,
      measuredAt: Date,
      signal?: AbortSignal,
    ): Promise<{
      syncOutcome: VsphereSyncOutcome;
      syncError: string | null;
      snapshotPeriod: Date | null;
      clustersSnapshotted: number;
    }>;
  };
  liveUsage: {
    record(connectionId: string, inventory: CollectedInventory, measuredAt: Date): Promise<number>;
  };
  /** The poll's own collect — sync and snapshot own their collects internally. */
  collector: Pick<VsphereInventoryCollector, 'collect'>;
}

export interface JobRunnerOptions extends JobRunnerServices {
  prisma: PrismaClient;
  /**
   * Load-shed signal (design §D25). Skips the poll — never the sync or snapshot —
   * when the event loop is under pressure. Guarded by the plugin for the test
   * environment, where `@fastify/under-pressure` is not registered.
   */
  isUnderPressure: () => boolean;
}

/**
 * The one claimed job body (#191, epic #172, design §D15a): for one connection, run
 * the due activities in the order sync → snapshot → poll, and report what each did so
 * the scheduler can write the status columns and pick the next `dueAt`.
 *
 * @ai-warning The ordering is load-bearing, not cosmetic:
 *   1. **A snapshot forces a fresh sync first.** `VsphereSnapshotService.runSnapshot`
 *      owns that sync, so when the snapshot is due this runner does NOT sync
 *      separately — doing both would reconcile the vCenter twice per monthly tick.
 *   2. **A sync failure aborts the snapshot.** A baseline with a stale capacity
 *      denominator is worse than a missing one; `runSnapshot` returns
 *      `snapshotPeriod: null` whenever its sync did not return ok, and this runner
 *      reports that as a sync failure, never a snapshot outage.
 *   3. **The poll is load-shed under pressure**, and it never fails the snapshot: a
 *      failed 5-minute poll is not a broken monthly baseline (D16a).
 *
 * @ai-warning Reports failures, never throws them. It runs outside Fastify's
 * request-scoped error handler, and `index.ts` turns an unhandled rejection into
 * `process.exit(1)` — so a thrown vCenter timeout would crash-loop the server.
 */
export class VsphereJobRunner implements JobRunner {
  private readonly prisma: PrismaClient;
  private readonly services: JobRunnerServices;
  private readonly isUnderPressure: () => boolean;

  constructor(options: JobRunnerOptions) {
    this.prisma = options.prisma;
    this.isUnderPressure = options.isUnderPressure;
    this.services = {
      connections: options.connections,
      sync: options.sync,
      snapshot: options.snapshot,
      liveUsage: options.liveUsage,
      collector: options.collector,
    };
  }

  async run(
    connectionId: string,
    measuredAt: Date,
    due: DueState,
    signal: AbortSignal,
  ): Promise<JobRunReport> {
    const report: JobRunReport = {
      poll: { ran: false, ok: false },
      sync: { outcome: null },
      snapshot: { attempted: false, period: null, failed: false },
      errorMessage: null,
    };

    const connection = await this.prisma.vsphereConnection.findUnique({
      where: { id: connectionId },
      select: {
        tenantId: true,
        hostname: true,
        port: true,
        username: true,
        enabled: true,
        tlsPinnedCaPem: true,
      },
    });
    // Defensive: the enabled filter in the scheduler's query and claim should make
    // both of these unreachable (the job row cascades with its connection, and a
    // disabled connection is never selected). Reported as `skipped` — never a failure,
    // so a transient race cannot trigger a false backoff storm.
    if (!connection || !connection.enabled) {
      report.sync.outcome = 'skipped';
      return report;
    }

    let password: string;
    try {
      password = await this.services.connections.revealPassword(connection.tenantId, connectionId);
    } catch {
      // The stored credential could not be decrypted (missing/rotated key). This is a
      // configuration fault, not a vCenter one, and no amount of retrying fixes it —
      // but it must degrade, not crash. Surface it on the connection and back off.
      await this.prisma.vsphereConnection
        .update({
          where: { id: connectionId },
          data: {
            status: 'secret_undecryptable',
            lastError: 'The stored vCenter credential could not be decrypted.',
          },
        })
        .catch(() => undefined);
      report.errorMessage = 'The stored vCenter credential could not be decrypted.';
      return report;
    }

    const credentials: VsphereCredentials = {
      hostname: connection.hostname,
      port: connection.port,
      username: connection.username,
      password,
      pinnedRootPem: connection.tlsPinnedCaPem,
    };

    // 1 + 2. Sync (and, when the snapshot is due, the snapshot it forces). The
    //        snapshot path owns its own sync, so the two branches are exclusive.
    if (due.snapshot) {
      try {
        const result = await this.services.snapshot.runSnapshot(
          connection.tenantId,
          connectionId,
          credentials,
          measuredAt,
          signal,
        );
        report.sync.outcome = result.syncOutcome;
        if (result.syncOutcome === 'ok') {
          report.snapshot = { attempted: true, period: result.snapshotPeriod, failed: false };
        } else if (result.syncOutcome !== 'skipped') {
          // Sync failed → snapshot deliberately aborted. A sync failure, not a
          // snapshot outage.
          report.errorMessage = result.syncError ?? 'vCenter sync failed.';
        }
      } catch (err) {
        // Only the MEASURE step (a second collect, or the DB write) throws — and only
        // after the internal sync returned ok. So the sync succeeded this tick; the
        // snapshot did not.
        report.sync.outcome = 'ok';
        report.snapshot = { attempted: true, period: null, failed: true };
        report.errorMessage = sanitizeJobError(err);
      }
    } else if (due.sync) {
      const result = await this.services.sync.syncConnection(
        connection.tenantId,
        connectionId,
        credentials,
        signal,
      );
      report.sync.outcome = result.outcome;
      if (result.outcome !== 'ok' && result.outcome !== 'skipped') {
        report.errorMessage = result.error ?? 'vCenter sync failed.';
      }
    }

    // 3. Poll — its own collect, load-shed under pressure. A poll failure never
    //    overrides a more significant sync/snapshot failure message.
    if (due.poll && !this.isUnderPressure()) {
      report.poll.ran = true;
      try {
        const inventory = await this.services.collector.collect(credentials, signal);
        await this.services.liveUsage.record(connectionId, inventory, measuredAt);
        report.poll.ok = true;
      } catch (err) {
        report.poll.ok = false;
        report.errorMessage = report.errorMessage ?? sanitizeJobError(err);
      }
    }

    return report;
  }
}
