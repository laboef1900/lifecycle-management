import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  CollectedInventory,
  VsphereInventoryCollector,
} from '../services/vsphere-inventory.js';
import { bytesToGiB, mibToGiB } from '../services/vsphere-inventory.js';
import { VsphereConnectionsService } from '../services/vsphere-connections.js';
import { VsphereSyncService } from '../services/vsphere-sync.js';
import { prisma } from './setup.js';

/**
 * Inventory reconciliation (#176, epic #172).
 *
 * The collector is a fake on purpose. `vcsim` gives every simulated host identical
 * memory and a frozen quickStats, so it can prove "we extract and shape the data
 * correctly" but never "the reconciliation is right" — and conflating the two
 * would build false confidence in numbers that buy hardware. These drive the logic
 * with hand-built inventories; the wire format is tested separately.
 */
const connections = new VsphereConnectionsService(prisma, randomBytes(32));

let seq = 0;
const uniq = (s: string): string => `sy-${s}-${++seq}`;
const made: string[] = [];

afterEach(async () => {
  if (made.length) {
    await prisma.host.deleteMany({ where: { connectionId: { in: made } } });
    await prisma.cluster.deleteMany({ where: { connectionId: { in: made } } });
    await prisma.vsphereConnection.deleteMany({ where: { id: { in: made.splice(0) } } });
  }
});

function fakeCollector(
  inv: CollectedInventory | (() => Promise<never>),
): VsphereInventoryCollector {
  return { collect: typeof inv === 'function' ? inv : async () => inv };
}

const CREDS = { hostname: 'vcenter.corp.local', username: 'u', password: 'p', pinnedRootPem: null };

function inventory(overrides: Partial<CollectedInventory> = {}): CollectedInventory {
  return {
    instanceUuid: 'uuid-vc-a',
    apiVersion: '8.0.3.0',
    clusters: [
      {
        moref: 'domain-c1',
        name: 'Production',
        hosts: [
          {
            moref: 'host-1',
            name: 'esx-01',
            memoryGiB: 512,
            usageGiB: 300,
            inMaintenanceMode: false,
            connected: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}

async function makeConn(name = uniq('conn')): Promise<string> {
  const c = await connections.create('default', {
    name,
    hostname: 'vcenter.corp.local',
    username: 'u',
    password: 'p',
    enabled: true,
  });
  made.push(c.id);
  return c.id;
}

describe('units — the highest-severity trap in the epic', () => {
  it('converts bytes to GiB, not decimal GB', () => {
    // A 512 GiB host. Decimal GB would report 549.756 — inflating capacity 7.4%
    // and deferring hardware purchases that are actually needed.
    expect(bytesToGiB(549_755_813_888)).toBe(512);
    expect(bytesToGiB(549_755_813_888)).not.toBeCloseTo(549.756, 2);
  });

  it("treats quickStats' documented MB as MiB", () => {
    // govc cluster.usage reconciles it with `<< 20`, i.e. x1048576 — so "MB" is MiB.
    expect(mibToGiB(1024)).toBe(1);
    expect(mibToGiB(1404)).toBeCloseTo(1.371, 3);
  });

  it("matches vcsim's template host exactly — which is NOT 4 GiB", () => {
    // 4294430720 bytes = 3.9995 GiB. Hard-coding `4` in a fixture assertion would
    // look right and be wrong.
    expect(bytesToGiB(4_294_430_720)).toBeCloseTo(3.9995, 4);
  });
});

describe('sync — import and update', () => {
  it('imports clusters and hosts, marking them as vsphere-sourced', async () => {
    const conn = await makeConn();
    const sync = new VsphereSyncService(prisma, fakeCollector(inventory()));

    const result = await sync.syncConnection('default', conn, CREDS);
    expect(result.outcome).toBe('ok');
    expect(result.clustersCreated).toBe(1);
    expect(result.hostsCreated).toBe(1);

    const cluster = await prisma.cluster.findFirstOrThrow({ where: { connectionId: conn } });
    expect(cluster.source).toBe('vsphere');
    expect(cluster.externalId).toBe('domain-c1');
    expect(cluster.externalName).toBe('Production');

    const host = await prisma.host.findFirstOrThrow({ where: { connectionId: conn } });
    // vCenter cannot tell us when a host was commissioned, so the date is
    // provisional and flagged — a wrong one silently zeroes capacity for every
    // earlier month.
    expect(host.commissionedAtProvisional).toBe(true);
  });

  it('is idempotent — a second run updates rather than duplicating', async () => {
    const conn = await makeConn();
    const sync = new VsphereSyncService(prisma, fakeCollector(inventory()));

    await sync.syncConnection('default', conn, CREDS);
    const second = await sync.syncConnection('default', conn, CREDS);

    expect(second.clustersCreated).toBe(0);
    expect(second.clustersUpdated).toBe(1);
    expect(await prisma.cluster.count({ where: { connectionId: conn } })).toBe(1);
    expect(await prisma.host.count({ where: { connectionId: conn } })).toBe(1);
  });

  it('★ a vCenter-side RENAME updates the label — it does not delete and recreate', async () => {
    const conn = await makeConn();
    await new VsphereSyncService(prisma, fakeCollector(inventory())).syncConnection(
      'default',
      conn,
      CREDS,
    );
    const before = await prisma.cluster.findFirstOrThrow({ where: { connectionId: conn } });

    const renamed = inventory();
    renamed.clusters[0]!.name = 'Production-EU';
    await new VsphereSyncService(prisma, fakeCollector(renamed)).syncConnection(
      'default',
      conn,
      CREDS,
    );

    const after = await prisma.cluster.findFirstOrThrow({ where: { connectionId: conn } });
    // Same row — because identity is the MoRef, which survives renames. Matching by
    // NAME would have made this delete+create and destroyed the baseline history.
    expect(after.id).toBe(before.id);
    expect(after.externalName).toBe('Production-EU');
  });

  it('never clobbers a label the operator has customised', async () => {
    const conn = await makeConn();
    const sync = new VsphereSyncService(prisma, fakeCollector(inventory()));
    await sync.syncConnection('default', conn, CREDS);

    const cluster = await prisma.cluster.findFirstOrThrow({ where: { connectionId: conn } });
    await prisma.cluster.update({
      where: { id: cluster.id },
      data: { name: uniq('operator-chosen'), nameIsCustom: true },
    });
    const chosen = (await prisma.cluster.findUniqueOrThrow({ where: { id: cluster.id } })).name;

    const renamed = inventory();
    renamed.clusters[0]!.name = 'Renamed-In-vCenter';
    await new VsphereSyncService(prisma, fakeCollector(renamed)).syncConnection(
      'default',
      conn,
      CREDS,
    );

    const after = await prisma.cluster.findUniqueOrThrow({ where: { id: cluster.id } });
    // The rename becomes a hint via externalName, not a clobbering.
    expect(after.name).toBe(chosen);
    expect(after.externalName).toBe('Renamed-In-vCenter');
  });
});

describe('⚠️ sync NEVER deletes', () => {
  it('a cluster that vanished from vCenter is counted, not removed', async () => {
    const conn = await makeConn();
    await new VsphereSyncService(prisma, fakeCollector(inventory())).syncConnection(
      'default',
      conn,
      CREDS,
    );

    const gone = inventory({ clusters: [] });
    const result = await new VsphereSyncService(prisma, fakeCollector(gone)).syncConnection(
      'default',
      conn,
      CREDS,
    );

    expect(result.clustersMissing).toBe(1);
    // Its baselines are irreplaceable — a destroyed August cannot be re-measured.
    // "The API didn't mention it this time" is not evidence it is gone.
    expect(await prisma.cluster.count({ where: { connectionId: conn } })).toBe(1);
  });
});

describe('⚠️ the identity guard', () => {
  it('★ refuses to sync when the hostname now answers as a DIFFERENT vCenter', async () => {
    const conn = await makeConn();
    await new VsphereSyncService(prisma, fakeCollector(inventory())).syncConnection(
      'default',
      conn,
      CREDS,
    );

    // DNS change, DR failover, or a rebuilt appliance reusing the name. Every
    // MoRef now refers to something else entirely.
    const impostor = inventory({ instanceUuid: 'uuid-vc-DIFFERENT' });
    impostor.clusters[0]!.name = 'Totally Different Cluster';

    const result = await new VsphereSyncService(prisma, fakeCollector(impostor)).syncConnection(
      'default',
      conn,
      CREDS,
    );

    expect(result.outcome).toBe('identity_mismatch');
    // Nothing was touched. Auto-adopting would have overwritten the wrong
    // cluster's hosts and capacity with plausible-looking numbers.
    const cluster = await prisma.cluster.findFirstOrThrow({ where: { connectionId: conn } });
    expect(cluster.externalName).toBe('Production');
    expect((await prisma.vsphereConnection.findUniqueOrThrow({ where: { id: conn } })).status).toBe(
      'identity_mismatch',
    );
  });
});

describe('⚠️ sync degrades, never crashes', () => {
  it('an unreachable vCenter returns an outcome rather than throwing', async () => {
    const conn = await makeConn();
    const sync = new VsphereSyncService(
      prisma,
      fakeCollector(async () => {
        throw new Error('connect ETIMEDOUT 10.0.0.1:443');
      }),
    );

    // The scheduler (#178) runs outside Fastify's request-scoped error handler, and
    // index.ts turns an unhandled rejection into process.exit(1) while compose sets
    // restart: unless-stopped — so a thrown timeout would crash-loop the server.
    const result = await sync.syncConnection('default', conn, CREDS);
    expect(result.outcome).toBe('unreachable');
    expect(result.error).toBe('Could not reach vCenter.');
  });

  it('a sanitized error never carries the credential or a raw driver message', async () => {
    const conn = await makeConn();
    const sync = new VsphereSyncService(
      prisma,
      fakeCollector(async () => {
        throw new Error('InvalidLogin: password "hunter2" rejected at /sdk stack...');
      }),
    );

    const result = await sync.syncConnection('default', conn, CREDS);
    expect(result.outcome).toBe('auth_failed');
    expect(result.error).not.toContain('hunter2');
    expect(result.error).not.toContain('stack');

    const row = await prisma.vsphereConnection.findUniqueOrThrow({ where: { id: conn } });
    // lastError is rendered in the UI and stored — it must never carry a secret.
    expect(row.lastError).not.toContain('hunter2');
  });

  it('a disabled connection is skipped without contacting vCenter', async () => {
    const conn = await makeConn();
    await prisma.vsphereConnection.update({ where: { id: conn }, data: { enabled: false } });

    let called = false;
    const sync = new VsphereSyncService(prisma, {
      collect: async () => {
        called = true;
        return inventory();
      },
    });

    const result = await sync.syncConnection('default', conn, CREDS);
    expect(result.outcome).toBe('skipped');
    expect(called).toBe(false);
  });
});

describe('two vCenters with the same cluster name', () => {
  it('both import, with distinguishable labels', async () => {
    const a = await makeConn(uniq('vc-a'));
    const b = await makeConn(uniq('vc-b'));

    await new VsphereSyncService(prisma, fakeCollector(inventory())).syncConnection(
      'default',
      a,
      CREDS,
    );
    await new VsphereSyncService(
      prisma,
      fakeCollector(inventory({ instanceUuid: 'uuid-vc-b' })),
    ).syncConnection('default', b, CREDS);

    const clusters = await prisma.cluster.findMany({ where: { connectionId: { in: [a, b] } } });
    expect(clusters).toHaveLength(2);
    // Both are called "Production" in vCenter...
    expect(clusters.every((c) => c.externalName === 'Production')).toBe(true);
    // ...but the operator must be able to tell which one needs hardware.
    expect(new Set(clusters.map((c) => c.name)).size).toBe(2);
  });
});
