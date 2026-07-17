import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { HostsService } from '../services/hosts.js';
import { VsphereConnectionsService } from '../services/vsphere-connections.js';
import type {
  CollectedInventory,
  VsphereInventoryCollector,
} from '../services/vsphere-inventory.js';
import { VsphereSyncService } from '../services/vsphere-sync.js';
import { buildServer } from '../server.js';

import { makeCluster, makeHost } from './factories.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

/**
 * Server-side enforcement of sync-owned fields on synced clusters and hosts
 * (#196, epic #172).
 *
 * The guard is field-aware: it refuses only the mutations vCenter owns
 * (host membership, cluster existence, non-zero synced baseline capacity — the
 * last lives in `sync-owned-baseline-capacity.test.ts`), and leaves every
 * operator-owned surface open on the same synced entity. `VsphereSyncService`
 * writes via Prisma directly, so the guard can never fight the sync itself; the
 * re-sync assertions below prove the sync path stays intact.
 */
let server: FastifyInstance;

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});

afterAll(async () => {
  await server.close();
});

function errorCode(res: { json: () => unknown }): string {
  return (res.json() as { error: { code: string } }).error.code;
}

const hostPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: `host-${Math.floor(Math.random() * 1e6)}`,
  commissionedAt: '2026-05-01',
  capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 512 }],
  ...overrides,
});

describe('host membership of a synced cluster is sync-owned', () => {
  it('rejects hand-adding a host under a synced cluster with 409 SYNC_OWNED_FIELD', async () => {
    const cluster = await makeCluster(prisma, { source: 'vsphere' });

    const res = await server.inject({
      method: 'POST',
      url: `/api/clusters/${cluster.id}/hosts`,
      payload: hostPayload(),
    });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('SYNC_OWNED_FIELD');
  });

  it('still allows adding a host under a manual cluster (no over-reach)', async () => {
    const cluster = await makeCluster(prisma); // manual by default

    const res = await server.inject({
      method: 'POST',
      url: `/api/clusters/${cluster.id}/hosts`,
      payload: hostPayload(),
    });

    expect(res.statusCode).toBe(201);
  });
});

describe('deleting a synced host is refused', () => {
  it('rejects DELETE of a synced host with 409 SYNC_OWNED_FIELD', async () => {
    const cluster = await makeCluster(prisma, { source: 'vsphere' });
    const host = await makeHost(prisma, { clusterId: cluster.id, source: 'vsphere' });

    const res = await server.inject({ method: 'DELETE', url: `/api/hosts/${host.id}` });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('SYNC_OWNED_FIELD');
    // The row survives — nothing was deleted.
    expect(await prisma.host.findUnique({ where: { id: host.id } })).not.toBeNull();
  });

  it('still deletes a manual host (no over-reach)', async () => {
    const cluster = await makeCluster(prisma);
    const host = await makeHost(prisma, { clusterId: cluster.id });

    const res = await server.inject({ method: 'DELETE', url: `/api/hosts/${host.id}` });

    expect(res.statusCode).toBe(204);
    expect(await prisma.host.findUnique({ where: { id: host.id } })).toBeNull();
  });
});

describe('deleting a synced cluster is refused (the most valuable rejection)', () => {
  it('rejects DELETE of a synced cluster with 409 SYNC_OWNED_FIELD', async () => {
    // A hollow delete would cascade away baseline history and the next sync would
    // re-create an empty twin under the same (connectionId, externalId).
    const cluster = await makeCluster(prisma, { source: 'vsphere' });

    const res = await server.inject({ method: 'DELETE', url: `/api/clusters/${cluster.id}` });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('SYNC_OWNED_FIELD');
    expect(await prisma.cluster.findUnique({ where: { id: cluster.id } })).not.toBeNull();
  });

  it('still deletes a manual cluster (no over-reach)', async () => {
    const cluster = await makeCluster(prisma);

    const res = await server.inject({ method: 'DELETE', url: `/api/clusters/${cluster.id}` });

    expect(res.statusCode).toBe(204);
    expect(await prisma.cluster.findUnique({ where: { id: cluster.id } })).toBeNull();
  });
});

describe('operator-owned surfaces stay open on synced entities', () => {
  it('appendCapacity is left open — it is the only path to synced-cluster capacity (#198)', async () => {
    const cluster = await makeCluster(prisma, { source: 'vsphere' });
    const host = await makeHost(prisma, {
      clusterId: cluster.id,
      source: 'vsphere',
      commissionedAt: new Date('2026-05-01T00:00:00.000Z'),
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/hosts/${host.id}/capacity`,
      payload: { metricTypeKey: 'memory_gb', effectiveFrom: '2026-08-01', amount: 256 },
    });

    expect(res.statusCode).toBe(201);
  });

  it('confirming commissionedAt on a synced host is left open (#194 confirm flow)', async () => {
    const cluster = await makeCluster(prisma, { source: 'vsphere' });
    const host = await makeHost(prisma, {
      clusterId: cluster.id,
      source: 'vsphere',
      commissionedAtProvisional: true,
      commissionedAt: new Date('2026-07-01T00:00:00.000Z'),
      initialCapacity: [],
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/hosts/${host.id}`,
      payload: { commissionedAt: '2020-01-01' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { commissionedAt: string; commissionedAtProvisional: boolean };
    expect(body.commissionedAt).toBe('2020-01-01');
    expect(body.commissionedAtProvisional).toBe(false);
  });

  it('editing description on a synced host is left open', async () => {
    const cluster = await makeCluster(prisma, { source: 'vsphere' });
    const host = await makeHost(prisma, { clusterId: cluster.id, source: 'vsphere' });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/hosts/${host.id}`,
      payload: { description: 'rack B, U12' },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { description: string }).description).toBe('rack B, U12');
  });
});

describe('operator rename pins a synced host label (nameIsCustom parity)', () => {
  const connections = new VsphereConnectionsService(prisma, randomBytes(32));
  const made: string[] = [];
  const CREDS = {
    hostname: 'vcenter.corp.local',
    username: 'u',
    password: 'p',
    pinnedRootPem: null,
  };

  function inventory(hostName: string): CollectedInventory {
    return {
      instanceUuid: 'uuid-vc-so',
      apiVersion: '8.0.3.0',
      clusters: [
        {
          moref: 'domain-c1',
          name: 'Production',
          hosts: [
            {
              moref: 'host-1',
              name: hostName,
              memoryGiB: 512,
              usageGiB: 300,
              inMaintenanceMode: false,
              connected: true,
            },
          ],
        },
      ],
    };
  }

  const fakeCollector = (inv: CollectedInventory): VsphereInventoryCollector => ({
    collect: async () => inv,
  });

  afterEach(async () => {
    // Synced clusters reference the connection (onDelete: Restrict), so drop hosts
    // and clusters before the connection — and before setup's global beforeEach
    // runs its unconditional cluster.deleteMany.
    if (made.length) {
      await prisma.host.deleteMany({ where: { connectionId: { in: made } } });
      await prisma.cluster.deleteMany({ where: { connectionId: { in: made } } });
      await prisma.vsphereConnection.deleteMany({ where: { id: { in: made.splice(0) } } });
    }
  });

  it('an operator rename survives a re-sync; externalName still tracks vCenter', async () => {
    const conn = await connections.create('default', {
      name: `so-conn-${Date.now()}`,
      hostname: 'vcenter.corp.local',
      username: 'u',
      password: 'p',
      enabled: true,
    });
    made.push(conn.id);

    const sync = new VsphereSyncService(prisma, fakeCollector(inventory('esx-01')));
    await sync.syncConnection('default', conn.id, CREDS);

    const created = await prisma.host.findFirstOrThrow({ where: { connectionId: conn.id } });
    expect(created.name).toBe('esx-01');
    expect(created.nameIsCustom).toBe(false);

    // The operator renames the host through the ordinary update path — pinning it.
    const hosts = new HostsService(prisma);
    await hosts.update('default', created.id, { name: 'esx-prod-01' });
    expect((await prisma.host.findUniqueOrThrow({ where: { id: created.id } })).nameIsCustom).toBe(
      true,
    );

    // vCenter reports the same host, still named 'esx-01'. externalName updates,
    // lastSyncedAt updates, but the operator's label must NOT be clobbered.
    const resync = new VsphereSyncService(prisma, fakeCollector(inventory('esx-01')));
    const second = await resync.syncConnection('default', conn.id, CREDS);
    expect(second.hostsUpdated).toBe(1);

    const after = await prisma.host.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.name).toBe('esx-prod-01');
    expect(after.externalName).toBe('esx-01');
    expect(after.nameIsCustom).toBe(true);
  });
});
