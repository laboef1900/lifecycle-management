import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  CollectedInventory,
  VsphereInventoryCollector,
} from '../services/vsphere-inventory.js';
import { VsphereConnectionsService } from '../services/vsphere-connections.js';
import { VsphereSnapshotService } from '../services/vsphere-snapshot.js';
import { prisma } from './setup.js';

/**
 * Monthly baseline snapshots (#178, epic #172).
 *
 * These write to the table that drives hardware purchasing, so the assertions
 * below are about arithmetic and idempotency rather than plumbing.
 */
const connections = new VsphereConnectionsService(prisma, randomBytes(32));

let seq = 0;
const uniq = (s: string): string => `snap-${s}-${++seq}`;
const made: string[] = [];

afterEach(async () => {
  if (made.length) {
    await prisma.host.deleteMany({ where: { connectionId: { in: made } } });
    await prisma.cluster.deleteMany({ where: { connectionId: { in: made } } });
    await prisma.vsphereConnection.deleteMany({ where: { id: { in: made.splice(0) } } });
  }
});

const CREDS = { hostname: 'vcenter.corp.local', username: 'u', password: 'p', pinnedRootPem: null };

function inventory(usage: Array<number | null> = [300, 200]): CollectedInventory {
  return {
    instanceUuid: 'uuid-vc-a',
    apiVersion: '8.0.3.0',
    clusters: [
      {
        moref: 'domain-c1',
        name: uniq('Prod'),
        hosts: usage.map((u, i) => ({
          moref: `host-${i}`,
          name: `esx-0${i}`,
          memoryGiB: 512,
          usageGiB: u,
          inMaintenanceMode: false,
          connected: u !== null,
        })),
      },
    ],
  };
}

const collector = (inv: CollectedInventory): VsphereInventoryCollector => ({
  collect: async () => inv,
});

async function makeConn(): Promise<string> {
  const c = await connections.create('default', {
    name: uniq('conn'),
    hostname: 'vcenter.corp.local',
    port: 443,
    username: 'u',
    password: 'p',
    enabled: true,
  });
  made.push(c.id);
  return c.id;
}

describe('⚠️ the snapshot must not double-count capacity', () => {
  it('★ writes baselineCapacity = 0 — the synced hosts ARE the capacity', async () => {
    const conn = await makeConn();
    const svc = new VsphereSnapshotService(prisma, collector(inventory()));

    await svc.runSnapshot('default', conn, CREDS, new Date('2026-08-01T00:00:00Z'));

    const row = await prisma.clusterBaselineHistory.findFirstOrThrow({
      where: { source: 'vsphere' },
      orderBy: { createdAt: 'desc' },
    });
    // forecast.ts treats baselineCapacity as an OFFSET and ADDS each host's
    // capacity to it. Writing the measured fleet capacity here would give
    // capacity = fleet + fleet: utilization halved, "plenty of headroom",
    // hardware never ordered. Plausible, silent, and the exact outage LCM exists
    // to prevent.
    expect(row.baselineCapacity.toNumber()).toBe(0);
    // Consumption IS measured — it is the portion no tracked entity models.
    expect(row.baselineConsumption.toNumber()).toBe(500);
  });

  it('sums only hosts that are actually reporting', async () => {
    const conn = await makeConn();
    // One host disconnected: counting it as 0 would look like consumption dropped.
    const svc = new VsphereSnapshotService(prisma, collector(inventory([300, null])));

    await svc.runSnapshot('default', conn, CREDS, new Date('2026-08-01T00:00:00Z'));
    const row = await prisma.clusterBaselineHistory.findFirstOrThrow({
      where: { source: 'vsphere' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.baselineConsumption.toNumber()).toBe(300);
  });
});

describe('⚠️ idempotency is enforced by Postgres, not by us', () => {
  it('★ two runs in the SAME month produce exactly ONE baseline', async () => {
    const conn = await makeConn();
    const svc = new VsphereSnapshotService(prisma, collector(inventory()));

    // Different DAYS of the same month — a restart, a retry after an outage. The
    // period anchor is the same, so the unique index refuses the second.
    await svc.runSnapshot('default', conn, CREDS, new Date('2026-08-01T00:00:00Z'));
    const second = await svc.runSnapshot('default', conn, CREDS, new Date('2026-08-17T09:30:00Z'));

    expect(second.clustersSnapshotted).toBe(0);
    const cluster = await prisma.cluster.findFirstOrThrow({ where: { connectionId: conn } });
    const rows = await prisma.clusterBaselineHistory.findMany({ where: { clusterId: cluster.id } });
    expect(rows).toHaveLength(1);
  });

  it('a NEW month appends rather than overwriting', async () => {
    const conn = await makeConn();
    const inv = inventory();
    await new VsphereSnapshotService(prisma, collector(inv)).runSnapshot(
      'default',
      conn,
      CREDS,
      new Date('2026-08-01T00:00:00Z'),
    );
    await new VsphereSnapshotService(prisma, collector(inv)).runSnapshot(
      'default',
      conn,
      CREDS,
      new Date('2026-09-01T00:00:00Z'),
    );

    const cluster = await prisma.cluster.findFirstOrThrow({ where: { connectionId: conn } });
    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
      orderBy: { capturedAt: 'asc' },
    });
    // The old baseline survives — the whole point of the epic.
    expect(rows.map((r) => r.capturedAt.toISOString().slice(0, 10))).toEqual([
      '2026-08-01',
      '2026-09-01',
    ]);
  });

  it("a human's correction for a period WINS — the job must not rewrite it", async () => {
    const conn = await makeConn();
    const svc = new VsphereSnapshotService(prisma, collector(inventory()));
    await svc.runSnapshot('default', conn, CREDS, new Date('2026-08-01T00:00:00Z'));

    const cluster = await prisma.cluster.findFirstOrThrow({ where: { connectionId: conn } });
    await prisma.clusterBaselineHistory.updateMany({
      where: { clusterId: cluster.id },
      data: { source: 'manual', baselineConsumption: 999 },
    });

    // skipDuplicates, not upsert: a re-run is a no-op. An admin who corrected a bad
    // sync must not have it silently undone by the next tick.
    await svc.runSnapshot('default', conn, CREDS, new Date('2026-08-20T00:00:00Z'));
    const row = await prisma.clusterBaselineHistory.findFirstOrThrow({
      where: { clusterId: cluster.id },
    });
    expect(row.baselineConsumption.toNumber()).toBe(999);
    expect(row.source).toBe('manual');
  });

  it('the period comes from the measurement clock, so a mid-month retry still writes the 1st', async () => {
    const conn = await makeConn();
    const svc = new VsphereSnapshotService(prisma, collector(inventory()));

    const result = await svc.runSnapshot('default', conn, CREDS, new Date('2026-08-23T14:07:00Z'));
    expect(result.snapshotPeriod?.toISOString().slice(0, 10)).toBe('2026-08-01');

    const row = await prisma.clusterBaselineHistory.findFirstOrThrow({
      where: { source: 'vsphere' },
      orderBy: { createdAt: 'desc' },
    });
    // observedAt keeps the real instant — informational, in no key, read by
    // nothing on the forecast path.
    expect(row.observedAt?.toISOString()).toBe('2026-08-23T14:07:00.000Z');
  });
});

describe('⚠️ sync-before-snapshot is mechanized, not hoped for', () => {
  it("a sync failure ABORTS this connection's snapshot", async () => {
    const conn = await makeConn();
    let calls = 0;
    const svc = new VsphereSnapshotService(prisma, {
      collect: async () => {
        calls += 1;
        throw new Error('connect ETIMEDOUT');
      },
    });

    // A baseline with a stale capacity denominator is WORSE than a missing one:
    // it is a plausible lie that silently biases purchasing, where a gap is merely
    // visible. We never write a baseline we cannot stand behind.
    //
    // The sync failure is RETURNED, not thrown: the scheduler (#191) stamps
    // lastSyncStatus from `syncOutcome` and must distinguish a sync failure from a
    // snapshot-measurement failure. `snapshotPeriod: null` is the abort — no
    // baseline is written, and the collect ran exactly once (sync's), never twice.
    const result = await svc.runSnapshot('default', conn, CREDS, new Date('2026-08-01T00:00:00Z'));
    expect(result.syncOutcome).toBe('unreachable');
    expect(result.snapshotPeriod).toBeNull();
    expect(calls).toBe(1);
    expect(await prisma.clusterBaselineHistory.count({ where: { source: 'vsphere' } })).toBe(0);
  });

  it('the snapshot sees hosts the sync just imported', async () => {
    const conn = await makeConn();
    const svc = new VsphereSnapshotService(prisma, collector(inventory()));

    await svc.runSnapshot('default', conn, CREDS, new Date('2026-08-01T00:00:00Z'));

    // The sync ran first, so the cluster exists to hang the baseline off — the
    // ordering is sequential statements in one body, not a race between two jobs.
    const cluster = await prisma.cluster.findFirstOrThrow({ where: { connectionId: conn } });
    expect(cluster.source).toBe('vsphere');
    expect(await prisma.host.count({ where: { clusterId: cluster.id } })).toBe(2);
    expect(await prisma.clusterBaselineHistory.count({ where: { clusterId: cluster.id } })).toBe(1);
  });
});
