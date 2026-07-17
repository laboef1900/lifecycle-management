import { addUtcMonths, startOfUtcMonth } from '@lcm/shared';
import type { PrismaClient } from '@prisma/client';

/** Injectable clock. Production passes the real one; tests pin it. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** How long a claim may look alive before another process reclaims it. */
const STALE_LEASE_MS = 15 * 60 * 1000;

/**
 * Backoff cap for a failing connection: **1 hour**, not the poll interval and not
 * OIDC's 60s.
 *
 * Retrying often is actively *desirable* here: the earlier in the month we catch a
 * recovery window, the more representative that month's baseline is. ~740 retries
 * against a dead vCenter is one cheap call each — trivial next to losing a month.
 */
const BACKOFF_CAP_MS = 60 * 60 * 1000;
const BACKOFF_BASE_MS = 30_000;

export function backoffMs(failureCount: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(failureCount, 10));
}

/** The next monthly boundary, computed forward from `now`. */
export function nextMonthlyBoundary(now: Date): Date {
  return addUtcMonths(startOfUtcMonth(now), 1);
}

export interface JobOutcome {
  connectionId: string;
  ran: boolean;
  snapshotPeriod: string | null;
  error: string | null;
}

/**
 * What one claimed job body does. Injected so the scheduler's claim/lease/backoff
 * logic is testable without a vCenter.
 */
export interface JobRunner {
  /** Resolves on success; throws on failure. The scheduler owns all error handling. */
  run(connectionId: string, measuredAt: Date): Promise<{ snapshotPeriod: Date | null }>;
}

/**
 * The in-process scheduler (#178, epic #172).
 *
 * @ai-warning `runDueJobs()` is the public entry point and the `setInterval` merely
 * calls it. Tests MUST call it directly — never start the timer, never sleep, never
 * fake time. To test "a month passed", **move `dueAt` in the database, not the
 * clock**. This is not a style preference: the suite uses fake timers nowhere, and
 * `vitest.config.ts` sets `isolate: false`, under which `vi.mock` was empirically
 * found to stop intercepting once other files import the same module (see the
 * comment in `oidc-plugin.test.ts`).
 *
 * @ai-warning **Nothing here may reject.** `plugins/error-handler.ts` is
 * request-scoped and cannot see a background job; `index.ts` turns an
 * `unhandledRejection` into `process.exit(1)`; and compose sets
 * `restart: unless-stopped`. So a single uncaught vCenter timeout would convert a
 * transient failure into a permanent restart loop — and would falsify every
 * "degrade, don't crash" claim in this codebase. `unhandledRejection → shutdown` is
 * *correct as written* for a purely request-scoped server; this file is what makes
 * that premise false, so this file is what must contain the failure.
 */
export class VsphereScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly runner: JobRunner,
    private readonly clock: Clock = systemClock,
    private readonly instanceId: string = `${process.pid}-${Math.floor(Date.now() / 1000)}`,
  ) {}

  /**
   * Start ticking. The tick is NOT the job period — it asks the database "is
   * anything due?" once a minute, which divides evenly into every cadence and
   * costs one indexed query.
   */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Belt-and-braces: runDueJobs already catches everything, but an unhandled
      // rejection escaping a bare setInterval callback would kill the process.
      void this.runDueJobs().catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Release any claim we hold so the next boot retries immediately rather than
    // waiting out the 15-minute stale lease.
    if (this.inFlight.size > 0) {
      await this.prisma.vsphereConnectionJob
        .updateMany({
          where: { lockedBy: this.instanceId },
          data: { runningSince: null, lockedBy: null },
        })
        .catch(() => undefined);
    }
  }

  /**
   * Run every job that is due. Called by the tick, and directly by tests.
   *
   * @ai-warning Never throws. See the class docstring.
   */
  async runDueJobs(): Promise<JobOutcome[]> {
    const now = this.clock.now();
    const due = await this.prisma.vsphereConnectionJob
      .findMany({ where: { dueAt: { lte: now } }, select: { connectionId: true } })
      .catch(() => []);

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
    // new row version, so the loser sees runningSince set and gets count === 0.
    //
    // This is not premature: `docker compose up -d` overlaps containers — the old
    // one drains for up to 10s while the new one boots and ticks — so a double-run
    // window exists on today's single-instance deployment.
    //
    // The stale-lease clause doubles as self-healing: a hard-killed process leaves
    // runningSince set, and the job recovers instead of wedging forever.
    const staleBefore = new Date(now.getTime() - STALE_LEASE_MS);
    const claim = await this.prisma.vsphereConnectionJob.updateMany({
      where: {
        connectionId,
        dueAt: { lte: now },
        OR: [{ runningSince: null }, { runningSince: { lt: staleBefore } }],
      },
      data: { runningSince: now, lockedBy: this.instanceId },
    });
    if (claim.count === 0) {
      return { connectionId, ran: false, snapshotPeriod: null, error: null };
    }

    this.inFlight.add(connectionId);
    try {
      const result = await this.runner.run(connectionId, now);
      await this.onSuccess(connectionId, now, result.snapshotPeriod);
      return {
        connectionId,
        ran: true,
        snapshotPeriod: result.snapshotPeriod ? isoDate(result.snapshotPeriod) : null,
        error: null,
      };
    } catch (err) {
      await this.onFailure(connectionId, now, err);
      return { connectionId, ran: true, snapshotPeriod: null, error: describe(err) };
    } finally {
      this.inFlight.delete(connectionId);
    }
  }

  private async onSuccess(
    connectionId: string,
    now: Date,
    snapshotPeriod: Date | null,
  ): Promise<void> {
    // ⚠️ The forward-advance is SUCCESS-ONLY, and it is computed forward from NOW —
    // never `dueAt + 1 month`. Three missed months therefore produce ONE catch-up
    // run, not three: three snapshots of *today's* usage backdated to three past
    // months would be fabricated data, which is actively worse than a gap.
    await this.prisma.vsphereConnectionJob
      .update({
        where: { connectionId },
        data: {
          dueAt: nextMonthlyBoundary(now),
          runningSince: null,
          lockedBy: null,
          failureCount: 0,
          lastError: null,
          ...(snapshotPeriod
            ? {
                lastSnapshotAt: now,
                lastSnapshotStatus: 'ok',
                lastSnapshotPeriod: snapshotPeriod,
                lastSuccessPeriod: snapshotPeriod,
              }
            : {}),
        },
      })
      .catch(() => undefined);
  }

  private async onFailure(connectionId: string, now: Date, err: unknown): Promise<void> {
    const job = await this.prisma.vsphereConnectionJob
      .findUnique({ where: { connectionId } })
      .catch(() => null);
    const failures = (job?.failureCount ?? 0) + 1;

    // ⚠️ NO PERIOD ADVANCE. EVER. `dueAt` moves by backoff only, so the job stays
    // inside its month and keeps trying.
    //
    // If this advanced to the next month on failure, a vCenter outage on 1 Aug
    // would cost August's baseline FOREVER — silently, invisibly, in an
    // append-only history whose entire purpose is an unbroken trend for
    // purchasing. The chart would simply have no August point.
    await this.prisma.vsphereConnectionJob
      .update({
        where: { connectionId },
        data: {
          dueAt: new Date(now.getTime() + backoffMs(failures)),
          runningSince: null,
          lockedBy: null,
          failureCount: failures,
          lastError: describe(err),
          lastSnapshotStatus: 'failed',
        },
      })
      .catch(() => undefined);
  }
}

/**
 * The period a snapshot taken at `measuredAt` belongs to.
 *
 * @ai-warning Derived from the measurement clock, **never from `dueAt`**. That is
 * what makes staying in-period *emergent* rather than an invariant someone has to
 * remember: a retry on 3 August recomputes 2026-08-01 by itself, so no "clamp the
 * backoff inside the period" rule is needed — and that clamp is exactly the version
 * that eventually breaks.
 */
export function periodFor(measuredAt: Date): Date {
  return startOfUtcMonth(measuredAt);
}

/**
 * Did a month go by without a successful snapshot?
 *
 * @ai-context A gap is legitimate — vCenter down all August means September writes
 * September only, and August stays honestly absent. A backdated August built from
 * September's usage would be *wrong data that looks real*, entering a purchasing
 * trend as a fact. But a gap must be VISIBLE: this is what turns "absent from a
 * chart" into "Missed: Aug 2026" in the settings panel.
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

/**
 * @ai-warning Sanitized. `lastError` is stored and rendered — it must never carry a
 * credential, a stack, or a driver internal. Detail belongs in the server log.
 */
function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/auth|login|credential/i.test(msg)) return 'vCenter rejected the credentials.';
  if (/cert|tls|self.signed/i.test(msg)) return 'vCenter presented an untrusted certificate.';
  if (/identity/i.test(msg)) return 'vCenter identity changed; sync is blocked pending re-adopt.';
  return 'Could not reach vCenter.';
}
