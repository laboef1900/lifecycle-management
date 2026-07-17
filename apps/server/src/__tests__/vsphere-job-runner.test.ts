import { randomBytes } from 'node:crypto';

import type { VsphereSyncOutcome, VsphereSyncResult } from '@lcm/shared';
import { afterEach, describe, expect, it } from 'vitest';

import type { CollectedInventory } from '../services/vsphere-inventory.js';
import { VsphereJobRunner, type JobRunnerServices } from '../services/vsphere-job-runner.js';
import type { DueState } from '../services/vsphere-scheduler.js';
import { makeVsphereConnection } from './factories.js';
import { prisma } from './setup.js';

/**
 * The single claimed job body (#191, epic §D15a). These prove the DISPATCH — sync →
 * snapshot → poll, the snapshot forcing (not repeating) the sync, a sync failure
 * aborting the snapshot, and the under-pressure poll skip — against spied services.
 * The scheduler's persistence given a report is tested in vsphere-scheduler.test.ts.
 */
const KEY = randomBytes(32);
let seq = 0;
const uniq = (s: string): string => `runner-${s}-${++seq}`;
const made: string[] = [];

afterEach(async () => {
  if (made.length) {
    await prisma.vsphereConnection.deleteMany({ where: { id: { in: made.splice(0) } } });
  }
});

const MEASURED_AT = new Date('2026-08-01T00:00:00Z');
const PERIOD = new Date('2026-08-01T00:00:00Z');

function inventory(): CollectedInventory {
  return { instanceUuid: 'uuid-a', apiVersion: '8.0', clusters: [] };
}

function syncResult(outcome: VsphereSyncOutcome, connectionId: string): VsphereSyncResult {
  return {
    connectionId,
    outcome,
    error: outcome === 'ok' ? null : 'Could not reach vCenter.',
    clustersCreated: 0,
    clustersUpdated: 0,
    clustersMissing: 0,
    hostsCreated: 0,
    hostsUpdated: 0,
    hostsMissing: 0,
  };
}

interface Spies {
  services: JobRunnerServices;
  calls: string[];
  syncCalls: () => number;
  pollCollectCalls: () => number;
}

/** Build spy services; overrides let a test force a specific outcome or throw. */
function spies(overrides: Partial<JobRunnerServices> = {}): Spies {
  const calls: string[] = [];
  const base: JobRunnerServices = {
    connections: { revealPassword: async () => 'secret' },
    sync: {
      syncConnection: async (_t, connectionId) => {
        calls.push('syncConnection');
        return syncResult('ok', connectionId);
      },
    },
    snapshot: {
      runSnapshot: async () => {
        calls.push('runSnapshot');
        return {
          syncOutcome: 'ok',
          syncError: null,
          snapshotPeriod: PERIOD,
          clustersSnapshotted: 1,
        };
      },
    },
    liveUsage: {
      record: async () => {
        calls.push('record');
        return 1;
      },
    },
    collector: {
      collect: async () => {
        calls.push('collect');
        return inventory();
      },
    },
  };
  const services: JobRunnerServices = {
    connections: overrides.connections ?? base.connections,
    sync: overrides.sync ?? base.sync,
    snapshot: overrides.snapshot ?? base.snapshot,
    liveUsage: overrides.liveUsage ?? base.liveUsage,
    collector: overrides.collector ?? base.collector,
  };
  return {
    services,
    calls,
    syncCalls: () => calls.filter((c) => c === 'syncConnection').length,
    pollCollectCalls: () => calls.filter((c) => c === 'collect').length,
  };
}

async function makeConn(enabled = true): Promise<string> {
  const { id } = await makeVsphereConnection(prisma, { key: KEY, name: uniq('conn'), enabled });
  made.push(id);
  return id;
}

function build(s: Spies, isUnderPressure = false): VsphereJobRunner {
  return new VsphereJobRunner({ prisma, isUnderPressure: () => isUnderPressure, ...s.services });
}

const ALL_DUE: DueState = { poll: true, sync: true, snapshot: true };

describe('D15a — one claimed body, sync → snapshot → poll', () => {
  it('a due snapshot forces the sync via runSnapshot and does NOT sync twice', async () => {
    const id = await makeConn();
    const s = spies();
    const report = await build(s).run(id, MEASURED_AT, ALL_DUE, new AbortController().signal);

    // runSnapshot owns the sync (§D15a); a separate syncConnection would reconcile
    // the vCenter a second time on every monthly tick.
    expect(s.syncCalls()).toBe(0);
    expect(s.calls).toEqual(['runSnapshot', 'collect', 'record']);
    expect(report.sync.outcome).toBe('ok');
    expect(report.snapshot).toEqual({ attempted: true, period: PERIOD, failed: false });
    expect(report.poll).toEqual({ ran: true, ok: true });
    expect(report.errorMessage).toBeNull();
  });

  it('when only sync + poll are due, sync runs before poll and snapshot is untouched', async () => {
    const id = await makeConn();
    const s = spies();
    const report = await build(s).run(
      id,
      MEASURED_AT,
      { poll: true, sync: true, snapshot: false },
      new AbortController().signal,
    );

    expect(s.calls).toEqual(['syncConnection', 'collect', 'record']);
    expect(report.snapshot.attempted).toBe(false);
    expect(report.sync.outcome).toBe('ok');
    expect(report.poll.ok).toBe(true);
  });

  it('a poll-only tick collects and records, nothing else', async () => {
    const id = await makeConn();
    const s = spies();
    const report = await build(s).run(
      id,
      MEASURED_AT,
      { poll: true, sync: false, snapshot: false },
      new AbortController().signal,
    );

    expect(s.calls).toEqual(['collect', 'record']);
    expect(report.sync.outcome).toBeNull();
    expect(report.poll).toEqual({ ran: true, ok: true });
  });
});

describe('⚠️ a sync failure aborts the snapshot deliberately', () => {
  it('reports the sync outcome, does not attempt the snapshot, writes no error as a snapshot outage', async () => {
    const id = await makeConn();
    const s = spies({
      snapshot: {
        runSnapshot: async () => ({
          syncOutcome: 'unreachable',
          syncError: 'Could not reach vCenter.',
          snapshotPeriod: null,
          clustersSnapshotted: 0,
        }),
      },
    });
    const report = await build(s).run(
      id,
      MEASURED_AT,
      { poll: false, sync: true, snapshot: true },
      new AbortController().signal,
    );

    expect(report.sync.outcome).toBe('unreachable');
    expect(report.snapshot).toEqual({ attempted: false, period: null, failed: false });
    expect(report.errorMessage).toBe('Could not reach vCenter.');
  });

  it('a snapshot MEASURE failure (sync ok) is reported as a snapshot failure', async () => {
    const id = await makeConn();
    const s = spies({
      snapshot: {
        runSnapshot: async () => {
          throw new Error('connect ETIMEDOUT');
        },
      },
    });
    const report = await build(s).run(
      id,
      MEASURED_AT,
      { poll: false, sync: true, snapshot: true },
      new AbortController().signal,
    );

    // The measure step only throws after the internal sync returned ok.
    expect(report.sync.outcome).toBe('ok');
    expect(report.snapshot).toEqual({ attempted: true, period: null, failed: true });
    expect(report.errorMessage).toBe('Could not reach vCenter.');
  });
});

describe('⚠️ load-shed: the poll is skipped under pressure, the snapshot is not', () => {
  it('skips the poll collect entirely when under pressure', async () => {
    const id = await makeConn();
    const s = spies();
    const report = await build(s, true).run(id, MEASURED_AT, ALL_DUE, new AbortController().signal);

    // Snapshot still ran (a due monthly baseline must not be lost to a pressure
    // window); the poll's own collect never happened.
    expect(s.calls).toContain('runSnapshot');
    expect(s.pollCollectCalls()).toBe(0);
    expect(report.poll).toEqual({ ran: false, ok: false });
  });
});

describe('degrade, never crash, on config faults', () => {
  it('a disabled connection is a no-op skip, never a failure', async () => {
    const id = await makeConn(false);
    const s = spies();
    const report = await build(s).run(id, MEASURED_AT, ALL_DUE, new AbortController().signal);

    expect(s.calls).toEqual([]);
    expect(report.sync.outcome).toBe('skipped');
    expect(report.errorMessage).toBeNull();
  });

  it('an undecryptable credential degrades and marks the connection, it does not throw', async () => {
    const id = await makeConn();
    const s = spies({
      connections: {
        revealPassword: async () => {
          throw new Error('stored password could not be decrypted');
        },
      },
    });
    const report = await build(s).run(id, MEASURED_AT, ALL_DUE, new AbortController().signal);

    expect(s.calls).toEqual([]);
    expect(report.errorMessage).toBe('The stored vCenter credential could not be decrypted.');
    const conn = await prisma.vsphereConnection.findUniqueOrThrow({ where: { id } });
    expect(conn.status).toBe('secret_undecryptable');
  });
});
