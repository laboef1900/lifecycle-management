import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { VsphereConnectionsService } from '../services/vsphere-connections.js';
import {
  backoffMs,
  missedPeriods,
  nextMonthlyBoundary,
  periodFor,
  VsphereScheduler,
  type Clock,
  type JobRunner,
} from '../services/vsphere-scheduler.js';
import { prisma } from './setup.js';

/**
 * The monthly snapshot scheduler (#178, epic #172).
 *
 * @ai-context No fake timers anywhere, deliberately. The suite uses them nowhere,
 * and `isolate: false` makes `vi.mock` unreliable here (see oidc-plugin.test.ts).
 * To test "a month passed", these MOVE `dueAt` IN THE DATABASE and call
 * `runDueJobs()` directly — the timer is never started and nothing sleeps.
 */
const connections = new VsphereConnectionsService(prisma, randomBytes(32));

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

const okRunner = (period = '2026-08-01'): JobRunner =>
  runner(async () => ({ snapshotPeriod: new Date(`${period}T00:00:00Z`) }));

async function makeJob(dueAt: string): Promise<string> {
  const c = await connections.create('default', {
    name: uniq('conn'),
    hostname: 'vcenter.corp.local',
    username: 'u',
    password: 'p',
    enabled: true,
  });
  made.push(c.id);
  await prisma.vsphereConnectionJob.create({
    data: { connectionId: c.id, dueAt: new Date(dueAt) },
  });
  return c.id;
}

describe('period derivation — the rule that makes in-period emergent', () => {
  it('derives the period from the MEASUREMENT clock, not from dueAt', () => {
    // A retry on 3 August recomputes 2026-08-01 by itself. That is why no
    // "clamp the backoff inside the period" rule is needed — and that clamp is
    // exactly the version that eventually breaks.
    expect(periodFor(new Date('2026-08-03T09:14:00Z')).toISOString().slice(0, 10)).toBe(
      '2026-08-01',
    );
    expect(periodFor(new Date('2026-08-31T23:59:59Z')).toISOString().slice(0, 10)).toBe(
      '2026-08-01',
    );
  });

  it('advances to the next boundary forward from NOW, never dueAt + 1 month', () => {
    // Three missed months must produce ONE catch-up run, not three snapshots of
    // today's usage backdated to three past months — that would be fabricated data.
    expect(nextMonthlyBoundary(new Date('2026-08-15T00:00:00Z')).toISOString().slice(0, 10)).toBe(
      '2026-09-01',
    );
    expect(nextMonthlyBoundary(new Date('2026-12-31T00:00:00Z')).toISOString().slice(0, 10)).toBe(
      '2027-01-01',
    );
  });

  it('anchoring on day 1 sidesteps addUtcMonths day-clamping', () => {
    // Anchored on the 31st, one pass through February would drift the schedule to
    // the 28th forever.
    expect(nextMonthlyBoundary(new Date('2026-01-31T00:00:00Z')).toISOString().slice(0, 10)).toBe(
      '2026-02-01',
    );
  });

  it('caps backoff at one hour — retrying often is desirable', () => {
    // The earlier in the month we catch a recovery window, the more representative
    // that month's baseline is.
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(50)).toBe(60 * 60 * 1000);
  });
});

describe('catch-up IS the data model', () => {
  it('a job whose dueAt is in the past runs on the next tick', async () => {
    // Server down three days ⇒ dueAt two days past ⇒ first tick runs it. There is
    // no "did I miss one?" branch to get wrong.
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

  it('three missed months produce ONE run, not three', async () => {
    const id = await makeJob('2026-05-01T00:00:00Z');
    let calls = 0;
    const sched = new VsphereScheduler(
      prisma,
      runner(async () => {
        calls += 1;
        return { snapshotPeriod: new Date('2026-08-01T00:00:00Z') };
      }),
      fixedClock('2026-08-04T10:00:00Z'),
    );

    await sched.runDueJobs();
    expect(calls).toBe(1);

    const job = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    // Forward from NOW — so the next run is September, not a march through the
    // months we missed writing today's usage into each.
    expect(job.dueAt.toISOString().slice(0, 10)).toBe('2026-09-01');
  });
});

describe('⚠️ a failed snapshot must NEVER consume its month', () => {
  it('★ failure advances dueAt by backoff only — it stays inside the month', async () => {
    const id = await makeJob('2026-08-01T00:00:00Z');
    const sched = new VsphereScheduler(
      prisma,
      runner(async () => {
        throw new Error('connect ETIMEDOUT');
      }),
      fixedClock('2026-08-01T00:00:00Z'),
    );

    await sched.runDueJobs();
    const job = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });

    // THE test. Had this advanced to September, a vCenter outage on 1 Aug would
    // have cost August's baseline forever — silently, in an append-only history
    // whose whole purpose is an unbroken trend. The chart would just have no
    // August point and nobody would know why.
    expect(job.dueAt.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(job.dueAt.getTime()).toBeGreaterThan(new Date('2026-08-01T00:00:00Z').getTime());
    expect(job.failureCount).toBe(1);
    expect(job.lastSuccessPeriod).toBeNull();
  });

  it('repeated failures keep it in-period and never advance the period', async () => {
    const id = await makeJob('2026-08-01T00:00:00Z');
    for (const at of ['2026-08-01T00:00:00Z', '2026-08-05T00:00:00Z', '2026-08-20T00:00:00Z']) {
      await prisma.vsphereConnectionJob.update({
        where: { connectionId: id },
        data: { dueAt: new Date(at) },
      });
      await new VsphereScheduler(
        prisma,
        runner(async () => {
          throw new Error('down');
        }),
        fixedClock(at),
      ).runDueJobs();
    }
    const job = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    expect(job.failureCount).toBe(3);
    expect(job.lastSuccessPeriod).toBeNull();
    expect(job.dueAt.toISOString().slice(0, 7)).toBe('2026-08');
  });

  it('success records the period and clears the failure count', async () => {
    const id = await makeJob('2026-08-01T00:00:00Z');
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
    expect(job.dueAt.toISOString().slice(0, 10)).toBe('2026-09-01');
  });

  it('a whole month lost is an HONEST GAP, and it is detectable', async () => {
    // vCenter down all August ⇒ 1 Sep writes September only. Fabricating August
    // from September's usage would be wrong data that looks real.
    const lastSuccess = new Date('2026-07-01T00:00:00Z');
    expect(missedPeriods(lastSuccess, new Date('2026-09-01T00:00:00Z'))).toBe(1);
    expect(missedPeriods(lastSuccess, new Date('2026-08-01T00:00:00Z'))).toBe(0);
    expect(missedPeriods(null, new Date('2026-09-01T00:00:00Z'))).toBe(0);
  });
});

describe('⚠️ the scheduler never crashes the server', () => {
  it('a throwing job is caught, recorded, and does not reject', async () => {
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
    expect(job.lastSnapshotStatus).toBe('failed');
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
        return { snapshotPeriod: new Date('2026-08-01T00:00:00Z') };
      }),
      fixedClock('2026-08-01T00:00:00Z'),
    );

    await sched.runDueJobs();
    const goodJob = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: good },
    });
    // A dead vCenter A must not deny B its baseline — that would turn a one-vCenter
    // outage into fleet-wide data loss.
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
          return { snapshotPeriod: new Date('2026-08-01T00:00:00Z') };
        }),
        fixedClock('2026-08-01T00:00:00Z'),
        `instance-${calls}-${Math.random()}`,
      );

    // `docker compose up -d` overlaps containers: the old one drains for up to 10s
    // while the new one boots and ticks. This is a real double-run window on the
    // single-instance deployment we have today, not a hypothetical replica.
    await Promise.all([mk().runDueJobs(), mk().runDueJobs()]);
    expect(calls).toBe(1);
    expect(id).toBeTruthy();
  });

  it('a stale lease is reclaimed so a hard-killed process self-heals', async () => {
    const id = await makeJob('2026-08-01T00:00:00Z');
    // Simulate a process killed mid-job 20 minutes ago.
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
    expect(outcomes.find((o) => o.connectionId === id)?.ran).toBe(false);
  });
});

describe('job rows die with their connection', () => {
  it('deleting a connection cascades the job row away — no orphan ticks forever', async () => {
    const c = await connections.create('default', {
      name: uniq('cascade'),
      hostname: 'vcenter.corp.local',
      username: 'u',
      password: 'p',
      enabled: true,
    });
    await prisma.vsphereConnectionJob.create({
      data: { connectionId: c.id, dueAt: new Date('2026-08-01T00:00:00Z') },
    });

    // Cascade is right here — the row is regenerable operational state. It is NOT
    // right for baselines, which are irreplaceable. An orphan would tick and fail
    // forever against a vCenter that no longer exists.
    await prisma.vsphereConnection.delete({ where: { id: c.id } });
    expect(await prisma.vsphereConnectionJob.count({ where: { connectionId: c.id } })).toBe(0);
  });
});
