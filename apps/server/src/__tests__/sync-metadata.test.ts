import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { VsphereConnectionsService } from '../services/vsphere-connections.js';
import { makeCluster } from './factories.js';
import { prisma } from './setup.js';

/**
 * Sync metadata and the connection FK (#176, epic #172).
 *
 * The cascade test below is the one that matters. It is not defensive
 * programming: `cluster_metric_baselines` and `cluster_baseline_history` BOTH
 * cascade from `clusters`, so had this FK been declared Cascade — the obvious
 * choice — deleting a vCenter connection in Settings would have silently deleted
 * every baseline the epic exists to accumulate.
 */
const service = new VsphereConnectionsService(prisma, randomBytes(32));

let seq = 0;
const uniq = (s: string): string => `sync-${s}-${++seq}`;
const made: string[] = [];

afterEach(async () => {
  if (made.length) {
    await prisma.cluster.deleteMany({ where: { connectionId: { in: made } } });
    await prisma.vsphereConnection.deleteMany({ where: { id: { in: made.splice(0) } } });
  }
});

async function makeConnection(): Promise<string> {
  const c = await service.create('default', {
    name: uniq('conn'),
    hostname: 'vcenter.corp.local',
    username: 'svc-lcm',
    password: 'pw',
    enabled: true,
  });
  made.push(c.id);
  return c.id;
}

describe('sync metadata — manual entities are untouched', () => {
  it('existing clusters default to source=manual with no sync fields', async () => {
    const cluster = await makeCluster(prisma, { name: uniq('manual') });
    const row = await prisma.cluster.findUniqueOrThrow({ where: { id: cluster.id } });

    // The migration is a pure additive default: nothing existing needed a backfill,
    // and manual clusters keep behaving exactly as before.
    expect(row.source).toBe('manual');
    expect(row.connectionId).toBeNull();
    expect(row.externalId).toBeNull();
    expect(row.nameIsCustom).toBe(false);
  });

  it('many manual clusters coexist despite the (connection, external) unique index', async () => {
    // NULLs are distinct in Postgres, so every manual cluster has a "different"
    // key. Without that property this index would allow exactly one manual cluster.
    await makeCluster(prisma, { name: uniq('null-a') });
    await makeCluster(prisma, { name: uniq('null-b') });
    await makeCluster(prisma, { name: uniq('null-c') });
    const rows = await prisma.cluster.findMany({ where: { connectionId: null, externalId: null } });
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});

describe('sync metadata — cluster identity', () => {
  it('the same MoRef from TWO vCenters is two different clusters', async () => {
    const a = await makeConnection();
    const b = await makeConnection();

    // `domain-c123` is unique only WITHIN a vCenter. Both of these exist, and they
    // are genuinely different clusters — which is exactly why external_id alone
    // cannot be the key.
    const ca = await makeCluster(prisma, { name: uniq('vc-a-prod') });
    const cb = await makeCluster(prisma, { name: uniq('vc-b-prod') });
    await prisma.cluster.update({
      where: { id: ca.id },
      data: { source: 'vsphere', connectionId: a, externalId: 'domain-c123' },
    });
    await prisma.cluster.update({
      where: { id: cb.id },
      data: { source: 'vsphere', connectionId: b, externalId: 'domain-c123' },
    });

    const rows = await prisma.cluster.findMany({ where: { externalId: 'domain-c123' } });
    expect(rows).toHaveLength(2);
  });

  it('the DATABASE rejects the same MoRef twice within ONE vCenter', async () => {
    const conn = await makeConnection();
    const first = await makeCluster(prisma, { name: uniq('dup-a') });
    const second = await makeCluster(prisma, { name: uniq('dup-b') });
    await prisma.cluster.update({
      where: { id: first.id },
      data: { source: 'vsphere', connectionId: conn, externalId: 'domain-c9' },
    });

    // Importing one vCenter cluster twice would double-count its capacity.
    await expect(
      prisma.cluster.update({
        where: { id: second.id },
        data: { source: 'vsphere', connectionId: conn, externalId: 'domain-c9' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('⚠️ connection delete NEVER cascades into baselines', () => {
  it('the DATABASE refuses to delete a connection that still owns clusters', async () => {
    const conn = await makeConnection();
    const cluster = await makeCluster(prisma, {
      name: uniq('owned'),
      baselineConsumption: 100,
      baselineCapacity: 1000,
    });
    await prisma.cluster.update({
      where: { id: cluster.id },
      data: { source: 'vsphere', connectionId: conn, externalId: 'domain-c1' },
    });

    // THE test. Had this FK been Cascade — the obvious choice — this delete would
    // have chained through clusters into cluster_baseline_history and destroyed the
    // purchasing history, silently, from a Settings misclick.
    //
    // Asserted on the message rather than a Prisma error code: the pg driver
    // adapter surfaces the constraint violation as a DriverAdapterError, so a
    // `code: 'P2003'` assertion would pass vacuously against the wrong error.
    await expect(prisma.vsphereConnection.delete({ where: { id: conn } })).rejects.toThrow(
      /foreign key constraint/i,
    );

    // Everything survives.
    const history = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: cluster.id },
    });
    expect(history.length).toBeGreaterThan(0);
  });

  it('detaching to manual preserves every cluster, host and baseline', async () => {
    const conn = await makeConnection();
    const cluster = await makeCluster(prisma, {
      name: uniq('detach'),
      baselineConsumption: 250,
      baselineCapacity: 1000,
    });
    await prisma.cluster.update({
      where: { id: cluster.id },
      data: { source: 'vsphere', connectionId: conn, externalId: 'domain-c2' },
    });

    // The supported path: null the references first, THEN delete. Restrict is
    // satisfied because nothing references the connection any more — which is why
    // Restrict does not "deadlock" the detach.
    await prisma.$transaction([
      prisma.cluster.updateMany({
        where: { connectionId: conn },
        data: {
          source: 'manual',
          connectionId: null,
          externalId: null,
          externalName: null,
          lastSyncedAt: null,
        },
      }),
      prisma.vsphereConnection.delete({ where: { id: conn } }),
    ]);

    const after = await prisma.cluster.findUniqueOrThrow({
      where: { id: cluster.id },
      include: { baselineHistory: true },
    });
    // The cluster becomes an ordinary manual cluster — the pre-vSphere state the
    // app already supports — and not one baseline was lost.
    expect(after.source).toBe('manual');
    expect(after.connectionId).toBeNull();
    expect(after.baselineHistory.length).toBeGreaterThan(0);
    expect(after.baselineHistory[0]?.baselineConsumption.toNumber()).toBe(250);
  });
});
