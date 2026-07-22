import { addUtcMonths, startOfUtcMonth, type VsphereSyncOutcome } from '@lcm/shared';
import { Prisma, type PrismaClient, type VsphereConnectionJob } from '@prisma/client';

import { POLL_INTERVAL_MS } from './vsphere-live-usage.js';
import { extractTlsErrorCode } from './vsphere-tls.js';

/** Injectable clock. Production passes the real one; tests pin it. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** How long a claim may look alive before another process reclaims it. */
const STALE_LEASE_MS = 15 * 60 * 1000;

/** Inventory sync cadence (design §D22): every 6 hours. A constant, not env — the app
 * stores settings in the DB and `CLAUDE.md` forbids new env-based app settings. */
export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Drain budget on shutdown (design §D21): half of index.ts's 10s window, leaving
 * headroom for Prisma `$disconnect`. */
const DRAIN_TIMEOUT_MS = 5_000;

/** ±10% jitter on the steady-state `dueAt` so N connections don't align into a
 * thundering herd (design §D22). */
const JITTER_FRACTION = 0.1;

/**
 * Hard outbound-work budget per one-minute scheduler tick. Connection creation is
 * reachable without a session while auth is disabled and seeds an immediately-due
 * job, so an unbounded `findMany` would turn a bounded HTTP route into an unbounded
 * persistent scan/resource-exhaustion path. Five keeps normal small fleets
 * immediate while making the worst case explicit and independent of queue depth.
 */
export const MAX_DUE_JOBS_PER_TICK = 5;

/**
 * First-contact jobs have never proved they are vCenter at all, so reserve at
 * most one slot per tick for them. Previously-connected vCenters consume the
 * remaining budget first and cannot be starved by anonymous connection creation.
 */
export const MAX_NEVER_CONNECTED_JOBS_PER_TICK = 1;

/**
 * Backoff cap for a failing SNAPSHOT: **1 hour**, not the poll interval and not
 * OIDC's 60s.
 *
 * Retrying often is actively *desirable* for the snapshot: the earlier in the month
 * we catch a recovery window, the more representative that month's baseline is. ~740
 * retries against a dead vCenter is one cheap call each — trivial next to losing a
 * month. Poll/sync-only ticks use {@link POLL_INTERVAL_MS} as the cap instead: a
 * dead vCenter retried faster than its normal cadence is just noise (design §D22).
 */
const BACKOFF_CAP_MS = 60 * 60 * 1000;
const BACKOFF_BASE_MS = 30_000;

/**
 * Exponential backoff, clamped at `capMs`. The cap is chosen by the caller from which
 * activity was due: {@link BACKOFF_CAP_MS} (1h) for a snapshot tick, {@link
 * POLL_INTERVAL_MS} (5m) for a poll/sync-only tick.
 */
export function backoffMs(failureCount: number, capMs: number = BACKOFF_CAP_MS): number {
  return Math.min(capMs, BACKOFF_BASE_MS * 2 ** Math.min(failureCount, 10));
}

/** The next monthly boundary, computed forward from `now`. */
export function nextMonthlyBoundary(now: Date): Date {
  return addUtcMonths(startOfUtcMonth(now), 1);
}

/**
 * Which of the three activities are due for one connection, derived from the job
 * row's last-run timestamps — never from `dueAt` (which is a single min-of-cadences
 * trigger, not per-activity state).
 *
 * @ai-warning `snapshot` due-ness comes from `lastSuccessPeriod` vs the current UTC
 * month, NOT from `dueAt` having reached a month boundary. With a 5-minute poll the
 * min-of-cadences `dueAt` is almost always the next poll, so a boundary-based test
 * would never fire the monthly snapshot. "Has this month been snapshotted?" is the
 * honest question, and a brand-new connection (`lastSuccessPeriod === null`)
 * snapshots the current, partially-elapsed month on its first tick (design §D16
 * catch-up).
 */
export interface DueState {
  poll: boolean;
  sync: boolean;
  snapshot: boolean;
}

export function computeDueState(
  job: { lastPollAt: Date | null; lastSyncAt: Date | null; lastSuccessPeriod: Date | null },
  now: Date,
): DueState {
  const nowMs = now.getTime();
  const pollDue = job.lastPollAt === null || nowMs - job.lastPollAt.getTime() >= POLL_INTERVAL_MS;
  const syncDue = job.lastSyncAt === null || nowMs - job.lastSyncAt.getTime() >= SYNC_INTERVAL_MS;
  const currentPeriod = startOfUtcMonth(now);
  const snapshotDue =
    job.lastSuccessPeriod === null || job.lastSuccessPeriod.getTime() < currentPeriod.getTime();
  return { poll: pollDue, sync: syncDue, snapshot: snapshotDue };
}

/**
 * What one claimed job body did, reported back so the scheduler can write the status
 * columns and pick the next `dueAt`. The runner reports outcomes rather than throwing
 * so a poll failure and a sync failure can be told apart (they write different status
 * columns and must never masquerade as each other — D16a).
 */
export interface JobRunReport {
  /** `ran` is false when the poll was not due, or was load-shed under pressure. */
  poll: { ran: boolean; ok: boolean };
  /** `null` when no sync was attempted this tick; otherwise the classified outcome. */
  sync: { outcome: VsphereSyncOutcome | null };
  /**
   * `attempted` is true only when the snapshot MEASURE step ran (its internal sync
   * returned ok). `period` set = success; `failed` = the measure/write threw. A
   * snapshot aborted because its sync failed is NOT attempted — that is a sync
   * failure, reported via `sync.outcome`.
   */
  snapshot: { attempted: boolean; period: Date | null; failed: boolean };
  /** Sanitized message of the most significant failure this tick, or `null`. */
  errorMessage: string | null;
}

/**
 * What one claimed job body does. Injected so the scheduler's claim/lease/backoff
 * logic is testable without a vCenter, and the runner's D15a dispatch is testable
 * without the scheduler.
 */
export interface JobRunner {
  /**
   * Runs the activities named in `due` (sync → snapshot → poll), reporting outcomes.
   * Expected failures are reported, not thrown; `signal` cancels in-flight vCenter
   * I/O on shutdown (design §D21).
   */
  run(
    connectionId: string,
    measuredAt: Date,
    due: DueState,
    signal: AbortSignal,
  ): Promise<JobRunReport>;
}

/**
 * The in-process scheduler (#178/#191, epic #172).
 *
 * @ai-warning `runDueJobs()` is the public entry point and the `setInterval` merely
 * calls it. Tests MUST call it directly — never start the timer, never sleep, never
 * fake time. To test "a month passed", **move the job's timestamps in the database,
 * not the clock**. This is not a style preference: the suite uses fake timers
 * nowhere, and `vitest.config.ts` sets `isolate: false`, under which `vi.mock` was
 * empirically found to stop intercepting once other files import the same module (see
 * the comment in `oidc-plugin.test.ts`).
 *
 * @ai-warning **Nothing here may reject.** `plugins/error-handler.ts` is
 * request-scoped and cannot see a background job; `index.ts` turns an
 * `unhandledRejection` into `process.exit(1)`; and compose sets
 * `restart: unless-stopped`. So a single uncaught vCenter timeout would convert a
 * transient failure into a permanent restart loop — and would falsify every
 * "degrade, don't crash" claim in this codebase. `runDueJobs()` and the runner both
 * catch everything — keep it that way.
 */
export class VsphereScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();
  private readonly activeRuns = new Set<Promise<JobOutcome[]>>();
  /** The graceful-shutdown token (design §D21). Aborted once, terminally, by `stop()`. */
  private readonly abortController = new AbortController();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly runner: JobRunner,
    private readonly clock: Clock = systemClock,
    private readonly instanceId: string = `${process.pid}-${Math.floor(Date.now() / 1000)}`,
    private readonly drainTimeoutMs: number = DRAIN_TIMEOUT_MS,
  ) {}

  /**
   * Start ticking. The tick is NOT the job period — it asks the database "is
   * anything due?" once a minute, which divides evenly into every cadence and costs
   * one indexed query.
   */
  start(intervalMs = 60_000): void {
    if (this.timer || this.abortController.signal.aborted) return;
    this.timer = setInterval(() => {
      // Belt-and-braces: runDueJobs already catches everything, but an unhandled
      // rejection escaping a bare setInterval callback would kill the process.
      void this.runDueJobs().catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  /** Whether the tick is currently running — the plugin skips `start()` in test. */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Graceful shutdown (design §D21): stop the tick, abort in-flight vCenter I/O, wait
   * for in-flight runs to settle (capped), then release any claim we still hold so the
   * next boot retries immediately rather than waiting out the 15-minute stale lease.
   *
   * @ai-warning The drain comes BEFORE the release, unlike the naive version: releasing
   * a claim while its job is still writing would let a concurrently-booting container
   * (the `docker compose up -d` overlap) re-run it.
   */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abortController.abort();
    await Promise.race([Promise.allSettled([...this.activeRuns]), delay(this.drainTimeoutMs)]);
    await this.prisma.vsphereConnectionJob
      .updateMany({
        where: { lockedBy: this.instanceId },
        data: { runningSince: null, lockedBy: null },
      })
      .catch(() => undefined);
  }

  /**
   * Run every job that is due. Called by the tick, and directly by tests.
   *
   * @ai-warning Never throws. See the class docstring.
   */
  async runDueJobs(): Promise<JobOutcome[]> {
    // Register the run so `stop()` can drain it — whether it was kicked off by the
    // tick or directly by a test.
    const run = this.executeDueJobs();
    this.activeRuns.add(run);
    try {
      return await run;
    } finally {
      this.activeRuns.delete(run);
    }
  }

  private async executeDueJobs(): Promise<JobOutcome[]> {
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - STALE_LEASE_MS);
    const available: Prisma.VsphereConnectionJobWhereInput = {
      dueAt: { lte: now },
      OR: [{ runningSince: null }, { runningSince: { lt: staleBefore } }],
    };

    // Previously-connected vCenters get first claim on the budget. A caller who
    // can anonymously create never-connected rows must not be able to starve the
    // established inventory/snapshot path by keeping that queue non-empty.
    const established = await this.prisma.vsphereConnectionJob
      .findMany({
        where: {
          ...available,
          connection: { enabled: true, lastConnectedAt: { not: null } },
        },
        orderBy: [{ dueAt: 'asc' }, { connectionId: 'asc' }],
        take: MAX_DUE_JOBS_PER_TICK,
        select: { connectionId: true },
      })
      .catch(() => null);
    if (established === null) return [];

    const firstContactBudget = Math.min(
      MAX_NEVER_CONNECTED_JOBS_PER_TICK,
      MAX_DUE_JOBS_PER_TICK - established.length,
    );
    const firstContact =
      firstContactBudget > 0
        ? await this.prisma.vsphereConnectionJob
            .findMany({
              // Disabled connections keep their job history but never run. Live
              // claims are excluded before applying the limit so they cannot
              // consume the scarce first-contact slot.
              where: {
                ...available,
                connection: { enabled: true, lastConnectedAt: null },
              },
              orderBy: [{ dueAt: 'asc' }, { connectionId: 'asc' }],
              take: firstContactBudget,
              select: { connectionId: true },
            })
            .catch(() => [])
        : [];
    const due = [...established, ...firstContact];

    const outcomes: JobOutcome[] = [];
    for (const { connectionId } of due) {
      outcomes.push(await this.runOne(connectionId));
    }
    return outcomes;
  }

  private async runOne(connectionId: string): Promise<JobOutcome> {
    const now = this.clock.now();
    if (this.inFlight.has(connectionId)) {
      return { connectionId, ran: false, snapshotPeriod: null, error: null };
    }

    // The claim. A single conditional UPDATE, atomic in Postgres: under READ
    // COMMITTED a concurrent writer blocks, then re-evaluates its WHERE against the
    // new row version, so the loser sees runningSince set and gets count === 0. The
    // enabled filter is repeated here so a connection disabled between select and
    // claim is not run. The stale-lease clause self-heals a hard-killed process.
    const staleBefore = new Date(now.getTime() - STALE_LEASE_MS);
    const claim = await this.prisma.vsphereConnectionJob.updateMany({
      where: {
        connectionId,
        dueAt: { lte: now },
        connection: { enabled: true },
        OR: [{ runningSince: null }, { runningSince: { lt: staleBefore } }],
      },
      data: { runningSince: now, lockedBy: this.instanceId },
    });
    if (claim.count === 0) {
      return { connectionId, ran: false, snapshotPeriod: null, error: null };
    }

    this.inFlight.add(connectionId);
    try {
      const job = await this.prisma.vsphereConnectionJob.findUniqueOrThrow({
        where: { connectionId },
      });
      const due = computeDueState(job, now);
      const report = await this.runner.run(connectionId, now, due, this.abortController.signal);

      if (this.abortController.signal.aborted) {
        // Draining: release the claim, leave `dueAt` untouched, record nothing. This
        // is a shutdown, not a fault — the next boot retries immediately (D21).
        await this.releaseClaim(connectionId);
        return { connectionId, ran: false, snapshotPeriod: null, error: null };
      }

      await this.persist(connectionId, now, job, due, report);
      return {
        connectionId,
        ran: true,
        snapshotPeriod: report.snapshot.period ? isoDate(report.snapshot.period) : null,
        error: report.errorMessage,
      };
    } catch (err) {
      if (this.abortController.signal.aborted) {
        await this.releaseClaim(connectionId);
        return { connectionId, ran: false, snapshotPeriod: null, error: null };
      }
      // Backstop: the runner catches per-activity and is not expected to throw, but an
      // unexpected throw must still degrade, never crash.
      await this.persistUnexpectedFailure(connectionId, now, err);
      return { connectionId, ran: true, snapshotPeriod: null, error: sanitizeJobError(err) };
    } finally {
      this.inFlight.delete(connectionId);
    }
  }

  /**
   * Persist the outcome of one run: stamp each activity's status columns, advance the
   * cadence timestamps ON SUCCESS ONLY, and set the next `dueAt`.
   */
  private async persist(
    connectionId: string,
    now: Date,
    job: VsphereConnectionJob,
    due: DueState,
    report: JobRunReport,
  ): Promise<void> {
    const data: Prisma.VsphereConnectionJobUpdateInput = {
      runningSince: null,
      lockedBy: null,
    };

    // Stamp each activity independently. Cadence timestamps (lastPollAt / lastSyncAt /
    // lastSuccessPeriod) advance ONLY on that activity's success, so a failed activity
    // stays "due" and retries under backoff rather than waiting out its full interval.
    if (report.poll.ran && report.poll.ok) data.lastPollAt = now;

    if (report.sync.outcome !== null) {
      data.lastSyncStatus = report.sync.outcome;
      if (report.sync.outcome === 'ok') data.lastSyncAt = now;
    }

    if (report.snapshot.attempted) {
      data.lastSnapshotAt = now;
      if (report.snapshot.period) {
        data.lastSnapshotStatus = 'ok';
        data.lastSnapshotPeriod = report.snapshot.period;
        data.lastSuccessPeriod = report.snapshot.period;
      } else if (report.snapshot.failed) {
        // ⚠️ Only a snapshot MEASUREMENT failure marks the snapshot failed. A poll or
        // sync failure must never render as a snapshot outage (D16a): the settings
        // panel reads lastSnapshotStatus to answer "is the monthly baseline broken?".
        data.lastSnapshotStatus = 'failed';
      }
    }

    if (report.errorMessage !== null) {
      // Something due this tick failed. Back off, capped by which activity was due: a
      // snapshot tick keeps the 1h cap; a poll/sync-only tick clamps at the poll
      // interval so a dead vCenter is not retried slower than its normal cadence.
      const cap = due.snapshot ? BACKOFF_CAP_MS : POLL_INTERVAL_MS;
      const failures = job.failureCount + 1;
      data.failureCount = failures;
      data.lastError = report.errorMessage;
      data.dueAt = new Date(now.getTime() + backoffMs(failures, cap));
    } else {
      data.failureCount = 0;
      data.lastError = null;
      data.dueAt = this.nextSuccessDueAt(now, job, report);
    }

    await this.prisma.vsphereConnectionJob
      .update({ where: { connectionId }, data })
      .catch(() => undefined);
  }

  /**
   * The next `dueAt` after a clean run: the earliest moment any activity is next due
   * (`min(nextPoll, nextSync, nextMonthBoundary)`) with ±10% jitter on the delay.
   */
  private nextSuccessDueAt(now: Date, job: VsphereConnectionJob, report: JobRunReport): Date {
    const nowMs = now.getTime();
    const lastPoll = report.poll.ran && report.poll.ok ? now : job.lastPollAt;
    const lastSync = report.sync.outcome === 'ok' ? now : job.lastSyncAt;
    const lastSuccessPeriod = report.snapshot.period ?? job.lastSuccessPeriod;

    const nextPoll = lastPoll ? lastPoll.getTime() + POLL_INTERVAL_MS : nowMs;
    const nextSync = lastSync ? lastSync.getTime() + SYNC_INTERVAL_MS : nowMs;
    const currentPeriod = startOfUtcMonth(now);
    const nextSnapshot =
      lastSuccessPeriod && lastSuccessPeriod.getTime() >= currentPeriod.getTime()
        ? nextMonthlyBoundary(now).getTime()
        : nowMs;

    const nextDue = Math.min(nextPoll, nextSync, nextSnapshot);
    // Jitter the DELAY, never the absolute boundary: a positive delay scaled by
    // [0.9, 1.1) stays positive, so the snapshot never fires into the previous month.
    return new Date(nowMs + jitter(Math.max(0, nextDue - nowMs)));
  }

  /** Release our claim without touching `dueAt` — the abort/shutdown path. */
  private async releaseClaim(connectionId: string): Promise<void> {
    await this.prisma.vsphereConnectionJob
      .updateMany({
        where: { connectionId, lockedBy: this.instanceId },
        data: { runningSince: null, lockedBy: null },
      })
      .catch(() => undefined);
  }

  /** Degrade an unexpected runner throw to a plain failure — never mark the snapshot. */
  private async persistUnexpectedFailure(
    connectionId: string,
    now: Date,
    err: unknown,
  ): Promise<void> {
    const job = await this.prisma.vsphereConnectionJob
      .findUnique({ where: { connectionId } })
      .catch(() => null);
    const failures = (job?.failureCount ?? 0) + 1;
    await this.prisma.vsphereConnectionJob
      .update({
        where: { connectionId },
        data: {
          dueAt: new Date(now.getTime() + backoffMs(failures)),
          runningSince: null,
          lockedBy: null,
          failureCount: failures,
          lastError: sanitizeJobError(err),
        },
      })
      .catch(() => undefined);
  }
}

export interface JobOutcome {
  connectionId: string;
  ran: boolean;
  snapshotPeriod: string | null;
  error: string | null;
}

/**
 * The period a snapshot taken at `measuredAt` belongs to.
 *
 * @ai-warning Derived from the measurement clock, **never from `dueAt`**. A retry on
 * 3 August recomputes 2026-08-01 by itself, so no "clamp the backoff inside the
 * period" rule is needed — and that clamp is exactly the version that eventually
 * breaks.
 */
export function periodFor(measuredAt: Date): Date {
  return startOfUtcMonth(measuredAt);
}

/**
 * Did a month go by without a successful snapshot?
 *
 * @ai-context A gap is legitimate — vCenter down all August means September writes
 * September only, and August stays honestly absent. A backdated August built from
 * September's usage would be *wrong data that looks real*. But a gap must be VISIBLE:
 * this is what turns "absent from a chart" into "Missed: Aug 2026" in the panel.
 */
export function missedPeriods(lastSuccess: Date | null, current: Date): number {
  if (!lastSuccess) return 0;
  const months =
    (current.getUTCFullYear() - lastSuccess.getUTCFullYear()) * 12 +
    (current.getUTCMonth() - lastSuccess.getUTCMonth());
  return Math.max(0, months - 1);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function jitter(delayMs: number): number {
  const factor = 1 + (Math.random() * 2 - 1) * JITTER_FRACTION; // [0.9, 1.1)
  return delayMs * factor;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * @ai-warning Sanitized. `lastError` is stored and rendered — it must never carry a
 * credential, a stack, or a driver internal. Detail belongs in the server log.
 *
 * @ai-note #280: the `CERT_FINGERPRINT_MISMATCH` branch MUST be checked via
 * `extractTlsErrorCode(err)`, not a message regex, and MUST come before the generic
 * `/cert|tls/` branch below — mirroring `classify`/`sanitize` in vsphere-sync.ts,
 * which is the reference behavior. The error `fingerprintPinnedConnection`
 * (vsphere-tls.ts) throws does NOT contain the literal string
 * `CERT_FINGERPRINT_MISMATCH` in its message, only in `err.code`; a message-regex
 * "mirror" would silently miss it and fall through to the generic untrusted-cert
 * message, losing the distinction that routes the operator to the "Replace the
 * trusted certificate" dialog.
 */
export function sanitizeJobError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (extractTlsErrorCode(err) === 'CERT_FINGERPRINT_MISMATCH') {
    return 'vCenter is presenting a different certificate than the one you trusted.';
  }
  if (/auth|login|credential/i.test(msg)) return 'vCenter rejected the credentials.';
  if (/cert|tls|self.signed/i.test(msg)) return 'vCenter presented an untrusted certificate.';
  if (/identity/i.test(msg)) return 'vCenter identity changed; sync is blocked pending re-adopt.';
  return 'Could not reach vCenter.';
}
