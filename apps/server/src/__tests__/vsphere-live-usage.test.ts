import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type { CollectedInventory } from '../services/vsphere-inventory.js';
import { VsphereConnectionsService } from '../services/vsphere-connections.js';
import { VsphereLiveUsageService, POLL_INTERVAL_MS } from '../services/vsphere-live-usage.js';
import { VsphereSyncService } from '../services/vsphere-sync.js';
import { prisma } from './setup.js';

/**
 * Live usage (#179, epic #172).
 *
 * The assertions here are mostly about what the API refuses to say. A capacity
 * tool that reports "0% used" when it means "we have no idea" is worse than one
 * that reports nothing.
 */
const connections = new VsphereConnectionsService(prisma, randomBytes(32));
const live = new VsphereLiveUsageService(prisma);

let seq = 0;
const uniq = (s: string): string => `lu-${s}-${++seq}`;
const made: string[] = [];

afterEach(async () => {
  if (made.length) {
    await prisma.host.deleteMany({ where: { connectionId: { in: made } } });
    await prisma.cluster.deleteMany({ where: { connectionId: { in: made } } });
    await prisma.vsphereConnection.deleteMany({ where: { id: { in: made.splice(0) } } });
  }
});

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

async function setup(inv: CollectedInventory): Promise<{ conn: string; clusterId: string }> {
  const c = await connections.create('default', {
    name: uniq('conn'),
    hostname: 'vcenter.corp.local',
    port: 443,
    username: 'u',
    password: 'p',
    enabled: true,
  });
  made.push(c.id);
  await new VsphereSyncService(prisma, { collect: async () => inv }).syncConnection(
    'default',
    c.id,
    {
      hostname: 'vcenter.corp.local',
      username: 'u',
      password: 'p',
      pinnedRootPem: null,
    },
  );
  const cluster = await prisma.cluster.findFirstOrThrow({ where: { connectionId: c.id } });
  return { conn: c.id, clusterId: cluster.id };
}

const NOW = new Date('2026-08-01T12:00:00Z');

describe('⚠️ "no data" can never masquerade as 0%', () => {
  it('★ a cluster with no sample returns null — never a zeroed reading', async () => {
    const { clusterId } = await setup(inventory());
    // The whole design in one assertion. `{ used: 0 }` here would render as
    // "0% utilized" — indistinguishable from "healthy, plenty of headroom", and
    // the state in which nobody orders hardware.
    expect(await live.forCluster(clusterId, NOW)).toBeNull();
  });

  it('never_fetched is STRUCTURALLY incapable of carrying numbers', () => {
    const result = live.neverFetched('c1', 'vc-prod');
    expect(result.state).toBe('never_fetched');
    // Not "is 0" — the field does not exist. A consumer cannot render a number it
    // cannot reach.
    expect(result).not.toHaveProperty('memoryUsedGiB');
  });
});

describe('live usage — recording and serving', () => {
  it('sums only reporting hosts and serves a fresh reading', async () => {
    const inv = inventory();
    const { conn, clusterId } = await setup(inv);
    await live.record(conn, inv, NOW);

    const result = await live.forCluster(clusterId, NOW);
    expect(result?.state).toBe('fresh');
    if (result?.state !== 'fresh') throw new Error('expected fresh');
    expect(result.memoryUsedGiB).toBe(500);
    expect(result.hostsSampled).toBe(2);
    expect(result.hostsTotal).toBe(2);
    expect(result.ageSeconds).toBe(0);
  });

  it('★ a partial read is signalled, not silently reported as a consumption drop', async () => {
    const inv = inventory([300, null]);
    const { conn, clusterId } = await setup(inv);
    await live.record(conn, inv, NOW);

    const result = await live.forCluster(clusterId, NOW);
    if (result?.state !== 'fresh') throw new Error('expected fresh');
    // 1 of 2 hosts reported. Treating the silent host as 0 GiB would look like
    // memory was freed — the opposite of the truth, in a tool that buys hardware.
    expect(result.memoryUsedGiB).toBe(300);
    expect(result.hostsSampled).toBe(1);
    expect(result.hostsTotal).toBe(2);
  });

  it('a poll upserts — the cache never grows', async () => {
    const inv = inventory();
    const { conn, clusterId } = await setup(inv);
    await live.record(conn, inv, NOW);
    await live.record(conn, inventory([400, 100]), new Date('2026-08-01T12:05:00Z'));

    expect(await prisma.vsphereUsageSample.count({ where: { clusterId } })).toBe(1);
    const result = await live.forCluster(clusterId, new Date('2026-08-01T12:05:00Z'));
    if (result?.state !== 'fresh') throw new Error('expected fresh');
    expect(result.memoryUsedGiB).toBe(500);
  });

  it('carries no capacity — the synced inventory is its one owner', async () => {
    const inv = inventory();
    const { conn, clusterId } = await setup(inv);
    await live.record(conn, inv, NOW);

    const row = await prisma.vsphereUsageSample.findUniqueOrThrow({ where: { clusterId } });
    // A live view whose denominator contradicts the forecast's is exactly how
    // users stop trusting the tool. Capacity changes on a scale of months; nothing
    // about it is live.
    expect(Object.keys(row)).not.toContain('memoryCapacityGiB');
  });
});

describe('staleness — computed server-side, with hysteresis', () => {
  it('one missed poll does NOT flap the UI to stale', async () => {
    const inv = inventory();
    const { conn, clusterId } = await setup(inv);
    await live.record(conn, inv, NOW);

    // 6 minutes: past one interval, inside the 2x window.
    const result = await live.forCluster(
      clusterId,
      new Date(NOW.getTime() + POLL_INTERVAL_MS + 60_000),
    );
    expect(result?.state).toBe('fresh');
  });

  it('beyond 2x the poll interval it is stale — with the last known value kept', async () => {
    const inv = inventory();
    const { conn, clusterId } = await setup(inv);
    await live.record(conn, inv, NOW);

    const result = await live.forCluster(clusterId, new Date(NOW.getTime() + 3 * POLL_INTERVAL_MS));
    expect(result?.state).toBe('stale');
    if (result?.state !== 'stale') throw new Error('expected stale');
    // Serve last-known rather than nothing — that is the degrade the epic requires.
    expect(result.memoryUsedGiB).toBe(500);
    expect(result.reason).toBe('unreachable');
  });

  it.each([
    ['auth_failed', 'auth_failed'],
    ['cert_mismatch', 'tls_untrusted'],
    ['identity_mismatch', 'identity_mismatch'],
  ])(
    'a %s connection reports reason=%s so the operator knows what to fix',
    async (status, expected) => {
      const inv = inventory();
      const { conn, clusterId } = await setup(inv);
      await live.record(conn, inv, NOW);
      await prisma.vsphereConnection.update({ where: { id: conn }, data: { status } });

      const result = await live.forCluster(clusterId, NOW);
      expect(result?.state).toBe('stale');
      if (result?.state !== 'stale') throw new Error('expected stale');
      // Collapsing these into one "stale" would tell the operator something is wrong
      // but not what to do about it.
      expect(result.reason).toBe(expected);
    },
  );

  it('a disabled connection is stale-by-choice, not a fault', async () => {
    const inv = inventory();
    const { conn, clusterId } = await setup(inv);
    await live.record(conn, inv, NOW);
    await prisma.vsphereConnection.update({ where: { id: conn }, data: { enabled: false } });

    const result = await live.forCluster(clusterId, NOW);
    if (result?.state !== 'stale') throw new Error('expected stale');
    expect(result.reason).toBe('disabled');
  });
});

describe('the cache survives what memory would not', () => {
  it('a reading persists across service instances — i.e. across a restart', async () => {
    const inv = inventory();
    const { conn, clusterId } = await setup(inv);
    await live.record(conn, inv, NOW);

    // A fresh instance stands in for a restarted process. An in-memory cache would
    // return "never fetched" here — precisely during an outage, which is when the
    // last-known value matters most.
    const afterRestart = new VsphereLiveUsageService(prisma);
    const result = await afterRestart.forCluster(clusterId, NOW);
    expect(result?.state).toBe('fresh');
  });

  it('samples die with their cluster — regenerable state, so cascade is right', async () => {
    const inv = inventory();
    const { conn, clusterId } = await setup(inv);
    await live.record(conn, inv, NOW);

    await prisma.host.deleteMany({ where: { clusterId } });
    await prisma.cluster.delete({ where: { id: clusterId } });
    expect(await prisma.vsphereUsageSample.count({ where: { clusterId } })).toBe(0);
  });
});
