import { FORECAST_SNAPSHOT_RETENTION_DISABLED, startOfUtcMonth } from '@lcm/shared';
import type { PrismaClient } from '@prisma/client';

import { retentionCutoffMonth } from '../lib/forecast-retention.js';

/** Drain budget on shutdown — matches `IdempotencyCleanup`. */
const DRAIN_TIMEOUT_MS = 5_000;

/**
 * How often the sweep runs. Fixed, not a setting: retention is measured in
 * MONTHS, so the tick rate is immaterial to correctness — a row that ages out is
 * already excluded from the band's read the moment it crosses the cutoff,
 * whether or not the sweep has caught up. The tick only decides when the disk
 * catches up with the read.
 *
 * `start()` schedules the first run one interval out rather than sweeping
 * immediately, so a freshly booted server prunes nothing for up to six hours.
 * That is deliberate for the same reason: nothing observable waits on it, and a
 * destructive job that fires during boot is harder to reason about than one that
 * fires on a predictable cadence.
 */
export const FORECAST_SNAPSHOT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface ForecastSnapshotCleanupLogger {
  info: (details: unknown, message: string) => void;
  warn: (details: unknown, message: string) => void;
}

const NOOP_LOGGER: ForecastSnapshotCleanupLogger = { info: () => undefined, warn: () => undefined };

/** What one tick did, per tenant that had retention switched on. */
export interface ForecastSnapshotSweepResult {
  tenantId: string;
  retentionMonths: number;
  cutoff: string;
  deleted: number;
}

/**
 * Prunes `forecast_snapshot` rows older than each tenant's configured retention
 * window (#318).
 *
 * @ai-warning THIS DELETES CAPACITY-FORECAST HISTORY NOTHING ELSE RECORDS. A
 * pruned snapshot is unrecoverable short of a `pg_dump` restore. Three
 * properties keep that safe, and all three must survive any edit here:
 *
 *  1. **Opt-in.** `forecastSnapshotRetentionMonths` defaults to 0 and a tenant at
 *     0 is SKIPPED outright — no cutoff is computed and no `deleteMany` is
 *     issued. A bug in the cutoff maths therefore cannot touch a
 *     default-configured deployment.
 *  2. **Keyed on `horizonMonth`.** A projection and the horizon-0 row supplying
 *     its measured actual share a `horizonMonth`, so this predicate retains or
 *     deletes both together — it can never strand a projection whose actual has
 *     been deleted (which `computeUncertainty` would swallow silently, since it
 *     skips unpaired rows without complaint).
 *  3. **Never ahead of the read.** The cutoff comes from `retentionCutoffMonth`,
 *     the same function the band's read uses, so the sweep can only ever delete
 *     rows the band had already stopped considering. Deleting is therefore
 *     invisible to the forecast, which is exactly what makes it safe.
 *
 * Unlike `IdempotencyCleanup`, which sweeps a precomputed `expiresAt` stamped at
 * write time, a snapshot has no write-time expiry — maturity is what matters —
 * so the cutoff is resolved per tenant on every tick and a retention change
 * applies retroactively.
 */
export class ForecastSnapshotCleanup {
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<ForecastSnapshotSweepResult[]> | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: ForecastSnapshotCleanupLogger = NOOP_LOGGER,
  ) {}

  start(intervalMs: number = FORECAST_SNAPSHOT_CLEANUP_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.race([this.activeRun ?? Promise.resolve([]), delay(DRAIN_TIMEOUT_MS)]);
  }

  /**
   * One pass over every tenant with retention enabled. Never throws — a failed
   * sweep is logged and the tick returns what it managed, so a persistently
   * broken sweep is visible in the log rather than silently never running. Each
   * tenant's delete is independent: one failure does not abort the others.
   *
   * Logs at INFO on every tenant it deleted from. Pruning is destructive and
   * otherwise leaves no trace — an operator must be able to reconstruct what was
   * removed and when from the server log alone.
   *
   * Not re-entrant by design: an overlapping call joins the run already in
   * flight rather than starting a second one. Two concurrent sweeps would be
   * harmless in themselves (the delete is idempotent), but the second would
   * overwrite `activeRun` and the first to settle would clear it — leaving
   * `stop()` draining a run that had already finished while a live one kept
   * deleting through shutdown.
   */
  async sweep(now: Date = new Date()): Promise<ForecastSnapshotSweepResult[]> {
    const inFlight = this.activeRun;
    if (inFlight) return inFlight;
    const run = this.runSweep(now);
    this.activeRun = run;
    try {
      return await run;
    } finally {
      this.activeRun = null;
    }
  }

  private async runSweep(now: Date): Promise<ForecastSnapshotSweepResult[]> {
    // `startOfUtcMonth`, never a local reimplementation: the band's read
    // normalises with the same function, and three copies of this one rule is
    // exactly how the sweep and the read drift apart with nothing pointing at
    // the connection. `retentionCutoffMonth` normalises again internally, so
    // this is belt-and-braces rather than load-bearing.
    const thisMonth = startOfUtcMonth(now);
    const tenants = await this.prisma.tenantSettings
      .findMany({
        where: { forecastSnapshotRetentionMonths: { gt: FORECAST_SNAPSHOT_RETENTION_DISABLED } },
        select: { tenantId: true, forecastSnapshotRetentionMonths: true },
      })
      .catch((err: unknown) => {
        this.logger.warn({ err }, 'forecast-snapshot cleanup could not read tenant settings');
        return [];
      });

    const results: ForecastSnapshotSweepResult[] = [];
    for (const tenant of tenants) {
      const retentionMonths = tenant.forecastSnapshotRetentionMonths;
      const cutoff = retentionCutoffMonth(thisMonth, retentionMonths);
      if (!cutoff) {
        // `retentionMonths > 0` per the filter above, so a null cutoff means the
        // stored value is outside `{0} u [MIN, MAX]` — the schema rejects those
        // on write, so it got there by a direct DB write. Retention fails SAFE
        // to off (INV-R1a) rather than clamping, because clamping would turn a
        // tampered value into real, unrecoverable deletes. Logged rather than
        // skipped silently: an operator who set a window and sees no pruning
        // needs the reason, and silence is how tampering stays invisible.
        this.logger.warn(
          { tenantId: tenant.tenantId, retentionMonths },
          'forecast-snapshot retention is out of range; keeping everything and pruning nothing',
        );
        continue;
      }

      // No index serves this predicate — both indexes on `forecast_snapshot`
      // lead with `cluster_id` — so each sweep sequentially scans the table.
      // Accepted deliberately: at <= 300 rows/cluster/year (design doc §12) on a
      // six-hour tick, the scan costs less than maintaining an index on every
      // snapshot write for this one query's benefit. Revisit if either the row
      // budget or the tick rate changes materially.
      const deleted = await this.prisma.forecastSnapshot
        .deleteMany({
          where: { tenantId: tenant.tenantId, horizonMonth: { lt: cutoff } },
        })
        .then((r) => r.count)
        .catch((err: unknown) => {
          this.logger.warn(
            { err, tenantId: tenant.tenantId },
            'forecast-snapshot cleanup sweep failed',
          );
          return -1;
        });
      if (deleted < 0) continue;

      const result: ForecastSnapshotSweepResult = {
        tenantId: tenant.tenantId,
        retentionMonths,
        cutoff: cutoff.toISOString().slice(0, 10),
        deleted,
      };
      results.push(result);
      if (deleted > 0) this.logger.info(result, 'pruned forecast snapshots past retention');
    }
    return results;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
