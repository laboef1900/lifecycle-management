import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { POLL_INTERVAL_MS } from '../services/vsphere-live-usage.js';
import {
  backoffMs,
  computeDueState,
  MAX_DUE_JOBS_PER_TICK,
  missedPeriods,
  nextMonthlyBoundary,
  periodFor,
  VsphereScheduler,
  type Clock,
  type JobRunner,
  type JobRunReport,
} from '../services/vsphere-scheduler.js';
import { makeVsphereConnection, makeVsphereConnectionJob } from './factories.js';
import { prisma } from './setup.js';

/**
 * The vCenter scheduler (#178/#191, epic #172).
 *
 * @ai-context No fake timers anywhere, deliberately. The suite uses them nowhere, and
 * `isolate: false` makes `vi.mock` unreliable here (see oidc-plugin.test.ts). To test
 * "a month passed", these MOVE the job's timestamps IN THE DATABASE and call
 * `runDueJobs()` directly — the timer is never started and nothing sleeps.
 *
 * The runner is a fake that returns a {@link JobRunReport}. That is the seam: these
 * tests drive the scheduler's claim/lease/persist logic given a report; the runner's
 * own D15a dispatch (sync → snapshot → poll) is tested in vsphere-job-runner.test.ts.
 */
const KEY = randomBytes(32);

let seq = 0;
const uniq = (s: string): string => `sch-${s}-${++seq}`;
const made: string[] = [];

afterEach(async () => {
  if (made.length) {
    await prisma.vsphereConnectionJob.deleteMany({ where: { connectionId: { in: made } } });
    await prisma.vsphereConnection.deleteMany({ where: { id: { in: made.splice(0) } } });
  }
});

const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });

function runner(impl: JobRunner['run']): JobRunner {
  return { run: impl };
}

/** A report where every activity succeeded — the steady-state happy path. */
const okReport = (period = '2026-08-01'): JobRunReport => ({
  poll: { ran: true, ok: true },
  sync: { outcome: 'ok' },
  snapshot: { attempted: true, period: new Date(`${period}T00:00:00Z`), failed: false },
  errorMessage: null,
});

const okRunner = (period = '2026-08-01'): JobRunner => runner(async () => okReport(period));

interface MakeJobOptions {
  lastPollAt?: Date | null;
  lastSyncAt?: Date | null;
  lastSuccessPeriod?: Date | null;
  lastSnapshotStatus?: string | null;
  failureCount?: number;
}

async function makeJob(dueAt: string, options: MakeJobOptions = {}): Promise<string> {
  const { id } = await makeVsphereConnection(prisma, {
    key: KEY,
    name: uniq('conn'),
    lastConnectedAt: new Date('2026-07-01T00:00:00Z'),
  });
  made.push(id);
  await makeVsphereConnectionJob(prisma, {
    connectionId: id,
    dueAt: new Date(dueAt),
    ...options,
  });
  return id;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('pure derivations', () => {
  it('derives the period from the MEASUREMENT clock, not from dueAt', () => {
    expect(periodFor(new Date('2026-08-03T09:14:00Z')).toISOString().slice(0, 10)).toBe(
      '2026-08-01',
    );
    expect(periodFor(new Date('2026-08-31T23:59:59Z')).toISOString().slice(0, 10)).toBe(
      '2026-08-01',
    );
  });

  it('advances to the next boundary forward from NOW, never dueAt + 1 month', () => {
    expect(nextMonthlyBoundary(new Date('2026-08-15T00:00:00Z')).toISOString().slice(0, 10)).toBe(
      '2026-09-01',
    );
    expect(nextMonthlyBoundary(new Date('2026-12-31T00:00:00Z')).toISOString().slice(0, 10)).toBe(
      '2027-01-01',
    );
    // Anchored on day 1 sidesteps addUtcMonths day-clamping through February.
    expect(nextMonthlyBoundary(new Date('2026-01-31T00:00:00Z')).toISOString().slice(0, 10)).toBe(
      '2026-02-01',
    );
  });

  it('backoff clamps at the given cap — poll interval for poll/sync, 1h for snapshot', () => {
    // 30s · 2^n, clamped. The default cap is 1h (snapshot); a poll/sync tick passes
    // POLL_INTERVAL_MS so a dead vCenter is never retried slower than its cadence.
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(50)).toBe(60 * 60 * 1000);
    expect(backoffMs(50, POLL_INTERVAL_MS)).toBe(POLL_INTERVAL_MS);
    expect(backoffMs(0, POLL_INTERVAL_MS)).toBe(30_000);
  });

  it('a whole month lost is an HONEST GAP, and it is detectable', () => {
    const lastSuccess = new Date('2026-07-01T00:00:00Z');
    expect(missedPeriods(lastSuccess, new Date('2026-09-01T00:00:00Z'))).toBe(1);
    expect(missedPeriods(lastSuccess, new Date('2026-08-01T00:00:00Z'))).toBe(0);
    expect(missedPeriods(null, new Date('2026-09-01T00:00:00Z'))).toBe(0);
  });
});

describe('computeDueState — per-activity due-ness from last-run timestamps', () => {
  const now = new Date('2026-08-15T12:00:00Z');

  it('a brand-new job (all null) is due for everything', () => {
    expect(
      computeDueState({ lastPollAt: null, lastSyncAt: null, lastSuccessPeriod: null }, now),
    ).toEqual({ poll: true, sync: true, snapshot: true });
  });

  it('poll is due at 5 minutes, not before', () => {
    const fourMin = new Date(now.getTime() - 4 * 60 * 1000);
    const sixMin = new Date(now.getTime() - 6 * 60 * 1000);
    expect(
      computeDueState({ lastPollAt: fourMin, lastSyncAt: now, lastSuccessPeriod: null }, now).poll,
    ).toBe(false);
    expect(
      computeDueState({ lastPollAt: sixMin, lastSyncAt: now, lastSuccessPeriod: null }, now).poll,
    ).toBe(true);
  });

  it('sync is due at 6 hours, not before', () => {
    const fiveH = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    const sevenH = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    expect(
      computeDueState({ lastPollAt: now, lastSyncAt: fiveH, lastSuccessPeriod: null }, now).sync,
    ).toBe(false);
    expect(
      computeDueState({ lastPollAt: now, lastSyncAt: sevenH, lastSuccessPeriod: null }, now).sync,
    ).toBe(true);
  });

  it('snapshot is due once per UTC month, from lastSuccessPeriod not dueAt', () => {
    const thisMonth = new Date('2026-08-01T00:00:00Z');
    const lastMonth = new Date('2026-07-01T00:00:00Z');
    expect(
      computeDueState({ lastPollAt: now, lastSyncAt: now, lastSuccessPeriod: thisMonth }, now)
        .snapshot,
    ).toBe(false);
    expect(
      computeDueState({ lastPollAt: now, lastSyncAt: now, lastSuccessPeriod: lastMonth }, now)
        .snapshot,
    ).toBe(true);
  });
});

describe('catch-up IS the data model', () => {
  it('a job whose dueAt is in the past runs on the next tick', async () => {
    const id = await makeJob('2026-08-01T00:00:00Z');
    const sched = new VsphereScheduler(prisma, okRunner(), fixedClock('2026-08-04T10:00:00Z'));
    const outcomes = await sched.runDueJobs();
    expect(outcomes.find((o) => o.connectionId === id)?.ran).toBe(true);
  });

  it('a job not yet due is left alone', async () => {
    const id = await makeJob('2026-09-01T00:00:00Z');
    const sched = new VsphereScheduler(prisma, okRunner(), fixedClock('2026-08-04T10:00:00Z'));
    const outcomes = await sched.runDueJobs();
    expect(outcomes.find((o) => o.connectionId === id)).toBeUndefined();
  });

  it('a disabled connection never runs, even with a due job row', async () => {
    // Seeded then disabled: the row survives (for its history) but must not tick,
    // or a deliberately disabled vCenter reports a perpetual, escalating false failure.
    const { id } = await makeVsphereConnection(prisma, {
      key: KEY,
      name: uniq('disabled'),
      enabled: false,
    });
    made.push(id);
    await makeVsphereConnectionJob(prisma, { connectionId: id, dueAt: new Date(0) });

    const sched = new VsphereScheduler(prisma, okRunner(), fixedClock('2026-08-04T10:00:00Z'));
    const outcomes = await sched.runDueJobs();
    expect(outcomes.find((o) => o.connectionId === id)).toBeUndefined();
  });

  it('runs at most the five oldest established connections in one tick', async () => {
    const ids: string[] = [];
    for (let day = 1; day <= 7; day++) {
      ids.push(await makeJob(`2026-08-0${day}T00:00:00Z`));
    }
    const calls: string[] = [];
    const sched = new VsphereScheduler(
      prisma,
      runner(async (connectionId) => {
        calls.push(connectionId);
        return okReport();
      }),
      fixedClock('2026-08-10T00:00:00Z'),
    );

    const outcomes = await sched.runDueJobs();
    expect(outcomes).toHaveLength(MAX_DUE_JOBS_PER_TICK);
    expect(calls).toEqual(ids.slice(0, MAX_DUE_JOBS_PER_TICK));
  });
});

describe('status columns — the writer the #202 dead columns needed', () => {
  it('a clean run stamps every column with the right outcome', async () => {
    const id = await makeJob('2026-08-01T00:00:00Z');
    await new VsphereScheduler(
      prisma,
      okRunner('2026-08-01'),
      fixedClock('2026-08-01T00:00:00Z'),
    ).runDueJobs();

    const job = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    expect(job.lastSyncStatus).toBe('ok');
    expect(job.lastSyncAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(job.lastPollAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(job.lastSnapshotStatus).toBe('ok');
    expect(job.lastSnapshotAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(job.lastSnapshotPeriod?.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(job.lastSuccessPeriod?.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(job.failureCount).toBe(0);
    expect(job.lastError).toBeNull();
    expect(job.runningSince).toBeNull();
    expect(job.lockedBy).toBeNull();
  });

  it('a clean run sets dueAt to the min-of-cadences — the 5-minute poll, jittered', async () => {
    const now = new Date('2026-08-01T00:00:00Z');
    const id = await makeJob(now.toISOString());
    await new VsphereScheduler(prisma, okRunner('2026-08-01'), {
      now: () => now,
    }).runDueJobs();

    const job = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    // min(now+5m poll, now+6h sync, next-month snapshot) = now+5m, ±10% jitter.
    const delta = job.dueAt.getTime() - now.getTime();
    expect(delta).toBeGreaterThanOrEqual(POLL_INTERVAL_MS * 0.9 - 1);
    expect(delta).toBeLessThanOrEqual(POLL_INTERVAL_MS * 1.1 + 1);
  });

  it('records the sync outcome vocabulary on a sync-only failure', async () => {
    // This month already snapshotted, so only poll+sync are due; the sync fails.
    const id = await makeJob('2026-08-10T00:00:00Z', {
      lastSuccessPeriod: new Date('2026-08-01T00:00:00Z'),
      lastSyncAt: new Date('2026-08-01T00:00:00Z'),
      lastPollAt: new Date('2026-08-10T00:00:00Z'),
    });
    await new VsphereScheduler(
      prisma,
      runner(async () => ({
        poll: { ran: false, ok: false },
        sync: { outcome: 'auth_failed' },
        snapshot: { attempted: false, period: null, failed: false },
        errorMessage: 'vCenter rejected the credentials.',
      })),
      fixedClock('2026-08-10T00:00:00Z'),
    ).runDueJobs();

    const job = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    expect(job.lastSyncStatus).toBe('auth_failed');
    // A sync failure must NOT stamp lastSyncAt — the sync is not "done", so it stays
    // due and retries under backoff rather than waiting out 6h.
    expect(job.lastSyncAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(job.failureCount).toBe(1);
    expect(job.lastError).toBe('vCenter rejected the credentials.');
  });
});

describe('⚠️ a failed snapshot must NEVER consume its month', () => {
  it('★ a snapshot failure advances dueAt by backoff only — it stays inside the month', async () => {
    const id = await makeJob('2026-08-01T00:00:00Z');
    await new VsphereScheduler(
      prisma,
      runner(async () => ({
        poll: { ran: true, ok: true },
        sync: { outcome: 'ok' },
        snapshot: { attempted: true, period: null, failed: true },
        errorMessage: 'Could not reach vCenter.',
      })),
      fixedClock('2026-08-01T00:00:00Z'),
    ).runDueJobs();

    const job = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    // Snapshot was due → 1h cap; backoff(1) = 60s. Stays inside August.
    expect(job.dueAt.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(job.dueAt.getTime()).toBe(new Date('2026-08-01T00:00:00Z').getTime() + 60_000);
    expect(job.failureCount).toBe(1);
    expect(job.lastSnapshotStatus).toBe('failed');
    expect(job.lastSuccessPeriod).toBeNull();
  });

  it('a POLL failure must NOT mark the monthly snapshot as failed', async () => {
    // The month is already snapshotted (ok); a failing 5-minute poll is not a broken
    // baseline, and rendering it as one would report a snapshot outage that never was.
    const id = await makeJob('2026-08-10T00:00:00Z', {
      lastSuccessPeriod: new Date('2026-08-01T00:00:00Z'),
      lastSnapshotStatus: 'ok',
      lastSyncAt: new Date('2026-08-10T00:00:00Z'),
    });
    await new VsphereScheduler(
      prisma,
      runner(async () => ({
        poll: { ran: true, ok: false },
        sync: { outcome: null },
        snapshot: { attempted: false, period: null, failed: false },
        errorMessage: 'Could not reach vCenter.',
      })),
      fixedClock('2026-08-10T00:00:00Z'),
    ).runDueJobs();

    const job = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    expect(job.lastSnapshotStatus).toBe('ok');
    expect(job.failureCount).toBe(1);
    expect(job.lastError).toBe('Could not reach vCenter.');
  });

  it('the backoff cap is chosen by which activity was due', async () => {
    const clock = fixedClock('2026-08-10T00:00:00Z');
    const failReport = (): JobRunReport => ({
      poll: { ran: true, ok: false },
      sync: { outcome: null },
      snapshot: { attempted: false, period: null, failed: false },
      errorMessage: 'Could not reach vCenter.',
    });
    const snapshotFailReport = (): JobRunReport => ({
      poll: { ran: true, ok: true },
      sync: { outcome: 'ok' },
      snapshot: { attempted: true, period: null, failed: true },
      errorMessage: 'Could not reach vCenter.',
    });

    // Poll-only failure (this month snapshotted) with 9 prior failures → 5m cap.
    const pollId = await makeJob('2026-08-10T00:00:00Z', {
      lastSuccessPeriod: new Date('2026-08-01T00:00:00Z'),
      lastSyncAt: new Date('2026-08-10T00:00:00Z'),
      failureCount: 9,
    });
    await new VsphereScheduler(
      prisma,
      runner(async () => failReport()),
      clock,
    ).runDueJobs();
    const pollJob = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: pollId },
    });
    expect(pollJob.dueAt.getTime()).toBe(
      new Date('2026-08-10T00:00:00Z').getTime() + POLL_INTERVAL_MS,
    );

    // Snapshot-due failure with 9 prior failures → 1h cap.
    const snapId = await makeJob('2026-08-10T00:00:00Z', { failureCount: 9 });
    await new VsphereScheduler(
      prisma,
      runner(async () => snapshotFailReport()),
      clock,
    ).runDueJobs();
    const snapJob = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: snapId },
    });
    expect(snapJob.dueAt.getTime()).toBe(
      new Date('2026-08-10T00:00:00Z').getTime() + 60 * 60 * 1000,
    );
  });

  it('success records the period and clears the failure count', async () => {
    const id = await makeJob('2026-08-01T00:00:00Z', { failureCount: 3 });
    await new VsphereScheduler(
      prisma,
      okRunner('2026-08-01'),
      fixedClock('2026-08-01T00:00:00Z'),
    ).runDueJobs();

    const job = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    expect(job.lastSuccessPeriod?.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(job.failureCount).toBe(0);
  });
});

describe('⚠️ the scheduler never crashes the server', () => {
  it('an unexpectedly throwing runner is caught, recorded, and does not reject', async () => {
    const id = await makeJob('2026-08-01T00:00:00Z');
    const sched = new VsphereScheduler(
      prisma,
      runner(async () => {
        throw new Error('boom');
      }),
      fixedClock('2026-08-01T00:00:00Z'),
    );

    // index.ts turns an unhandledRejection into process.exit(1) and compose sets
    // restart: unless-stopped — so one uncaught vCenter timeout would convert a
    // transient failure into a permanent restart loop.
    await expect(sched.runDueJobs()).resolves.toBeInstanceOf(Array);
    const job = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    expect(job.failureCount).toBe(1);
    expect(job.lastError).not.toBeNull();
    // The backstop must NOT invent a snapshot outage from an unclassified throw.
    expect(job.lastSnapshotStatus).toBeNull();
  });

  it('a sanitized error never carries the credential or a stack', async () => {
    const id = await makeJob('2026-08-01T00:00:00Z');
    await new VsphereScheduler(
      prisma,
      runner(async () => {
        throw new Error('InvalidLogin: password "hunter2" rejected\n  at /sdk:1:1');
      }),
      fixedClock('2026-08-01T00:00:00Z'),
    ).runDueJobs();

    const job = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    expect(job.lastError).not.toContain('hunter2');
    expect(job.lastError).not.toContain('/sdk');
    expect(job.lastError).toBe('vCenter rejected the credentials.');
  });

  it('one failing connection does not stop another from running', async () => {
    const bad = await makeJob('2026-08-01T00:00:00Z');
    const good = await makeJob('2026-08-01T00:00:00Z');
    const sched = new VsphereScheduler(
      prisma,
      runner(async (connectionId) => {
        if (connectionId === bad) throw new Error('down');
        return okReport('2026-08-01');
      }),
      fixedClock('2026-08-01T00:00:00Z'),
    );

    await sched.runDueJobs();
    const goodJob = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: good },
    });
    expect(goodJob.lastSuccessPeriod?.toISOString().slice(0, 10)).toBe('2026-08-01');
  });
});

describe('⚠️ concurrency — compose overlaps containers today', () => {
  it('★ two concurrent runs execute the job exactly ONCE', async () => {
    const id = await makeJob('2026-08-01T00:00:00Z');
    let calls = 0;
    const mk = (): VsphereScheduler =>
      new VsphereScheduler(
        prisma,
        runner(async () => {
          calls += 1;
          await new Promise((r) => setTimeout(r, 30));
          return okReport('2026-08-01');
        }),
        fixedClock('2026-08-01T00:00:00Z'),
        `instance-${calls}-${Math.random()}`,
      );

    await Promise.all([mk().runDueJobs(), mk().runDueJobs()]);
    expect(calls).toBe(1);
    expect(id).toBeTruthy();
  });

  it('a stale lease is reclaimed so a hard-killed process self-heals', async () => {
    const id = await makeJob('2026-08-01T00:00:00Z', {});
    await prisma.vsphereConnectionJob.update({
      where: { connectionId: id },
      data: { runningSince: new Date('2026-08-01T09:40:00Z'), lockedBy: 'dead-process' },
    });

    const outcomes = await new VsphereScheduler(
      prisma,
      okRunner(),
      fixedClock('2026-08-01T10:00:00Z'),
    ).runDueJobs();
    expect(outcomes.find((o) => o.connectionId === id)?.ran).toBe(true);
  });

  it('a FRESH lease is respected — someone else is genuinely running it', async () => {
    const id = await makeJob('2026-08-01T00:00:00Z');
    await prisma.vsphereConnectionJob.update({
      where: { connectionId: id },
      data: { runningSince: new Date('2026-08-01T09:59:00Z'), lockedBy: 'other-process' },
    });

    const outcomes = await new VsphereScheduler(
      prisma,
      okRunner(),
      fixedClock('2026-08-01T10:00:00Z'),
    ).runDueJobs();
    expect(outcomes.find((o) => o.connectionId === id)).toBeUndefined();
  });
});

describe('⚠️ graceful shutdown releases the claim without consuming the month', () => {
  it('★ stop() aborts an in-flight run, releases the claim, and leaves dueAt unchanged', async () => {
    const dueAt = '2026-08-01T00:00:00Z';
    const id = await makeJob(dueAt);
    const started = deferred();

    const sched = new VsphereScheduler(
      prisma,
      runner(async (_c, _m, _d, signal) => {
        started.resolve();
        // Block until shutdown aborts us, mimicking an in-flight vCenter collect.
        await new Promise<void>((res) => {
          if (signal.aborted) return res();
          signal.addEventListener('abort', () => res(), { once: true });
        });
        return okReport('2026-08-01');
      }),
      fixedClock(dueAt),
      'instance-drain',
      2_000,
    );

    const runPromise = sched.runDueJobs();
    await started.promise;

    // The claim is held while the job runs.
    const claimed = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    expect(claimed.runningSince).not.toBeNull();
    expect(claimed.lockedBy).toBe('instance-drain');

    await sched.stop();
    await runPromise;

    const after = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    // Released, dueAt untouched, nothing recorded — the next boot retries immediately.
    expect(after.runningSince).toBeNull();
    expect(after.lockedBy).toBeNull();
    expect(after.dueAt.toISOString()).toBe(new Date(dueAt).toISOString());
    expect(after.failureCount).toBe(0);
    expect(after.lastError).toBeNull();
  });
});

describe('job rows die with their connection', () => {
  it('deleting a connection cascades the job row away — no orphan ticks forever', async () => {
    const { id } = await makeVsphereConnection(prisma, { key: KEY, name: uniq('cascade') });
    await makeVsphereConnectionJob(prisma, {
      connectionId: id,
      dueAt: new Date('2026-08-01T00:00:00Z'),
    });

    await prisma.vsphereConnection.delete({ where: { id } });
    expect(await prisma.vsphereConnectionJob.count({ where: { connectionId: id } })).toBe(0);
  });
});
