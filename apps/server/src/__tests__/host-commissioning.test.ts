import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { HostsService } from '../services/hosts.js';
import type {
  CollectedInventory,
  VsphereInventoryCollector,
} from '../services/vsphere-inventory.js';
import { VsphereConnectionsService } from '../services/vsphere-connections.js';
import { VsphereSyncService } from '../services/vsphere-sync.js';
import { buildServer } from '../server.js';

import { makeCluster, makeHost } from './factories.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

/**
 * Confirming provisional commissioning dates on synced hosts (#194, epic #172).
 *
 * vCenter cannot tell us when a host was commissioned, so sync stamps a
 * provisional `commissionedAt` and flags it (`commissionedAtProvisional`, Q9c).
 * These tests pin the four behaviours the confirm flow owns: the flag reaches the
 * client, confirming (even "as-is") clears it, the bulk confirm is transactional,
 * and — the load-bearing invariant — a re-sync NEVER overwrites an operator-
 * confirmed date. That last test is the contract #196's sync-owned-field guard
 * must not break.
 *
 * @ai-note There is deliberately no live-forecast assertion here: this file pins
 * the confirm-flow contract directly, and its fixtures are built via `makeHost`
 * rather than a live sync. The forecast effect of a synced host's capacity — which
 * #198 now writes on sync — and its interaction with `commissionedAt` is covered in
 * the vsphere-sync and forecast suites. Capacity rows below are fabricated only to
 * exercise the INVALID_COMMISSIONED_AT guard.
 */
let server: FastifyInstance;

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});

afterAll(async () => {
  await server.close();
});

async function provisionalHost(
  clusterId: string,
  opts: { commissionedAt?: Date; withCapacityAt?: Date } = {},
): Promise<string> {
  const host = await makeHost(prisma, {
    clusterId,
    source: 'vsphere',
    commissionedAtProvisional: true,
    commissionedAt: opts.commissionedAt ?? new Date('2026-07-01T00:00:00.000Z'),
    // This fixture omits capacity rows by default to keep the confirm-flow tests
    // focused; pass one only to arm the INVALID_COMMISSIONED_AT guard.
    initialCapacity:
      opts.withCapacityAt !== undefined
        ? [{ effectiveFrom: opts.withCapacityAt, amount: 512 }]
        : [],
  });
  return host.id;
}

async function readHost(id: string): Promise<{ commissionedAt: string; provisional: boolean }> {
  const res = await server.inject({ method: 'GET', url: `/api/hosts/${id}` });
  const body = res.json() as { commissionedAt: string; commissionedAtProvisional: boolean };
  return { commissionedAt: body.commissionedAt, provisional: body.commissionedAtProvisional };
}

describe('host DTO exposes commissionedAtProvisional', () => {
  let clusterId: string;
  beforeEach(async () => {
    clusterId = (await makeCluster(prisma)).id;
  });

  it('is true for a provisional synced host and false for a manual host', async () => {
    const synced = await provisionalHost(clusterId);
    const manual = await makeHost(prisma, { clusterId });

    expect((await readHost(synced)).provisional).toBe(true);
    expect((await readHost(manual.id)).provisional).toBe(false);
  });
});

describe('PUT /api/hosts/:id confirms and clears the flag', () => {
  let clusterId: string;
  beforeEach(async () => {
    clusterId = (await makeCluster(prisma)).id;
  });

  it('setting commissionedAt clears the provisional flag', async () => {
    const id = await provisionalHost(clusterId, {
      commissionedAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/hosts/${id}`,
      payload: { commissionedAt: '2024-01-15' },
    });

    expect(res.statusCode).toBe(200);
    const after = await readHost(id);
    expect(after.provisional).toBe(false);
    expect(after.commissionedAt).toBe('2024-01-15');
  });

  it('confirm-as-is: an unchanged date still clears the flag', async () => {
    const id = await provisionalHost(clusterId, {
      commissionedAt: new Date('2026-07-01T00:00:00.000Z'),
      withCapacityAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    // The operator inspected the import date and accepted it — same value, but the
    // flag must clear. The guard allows it: 2026-07-01 is not after the earliest
    // capacity row (also 2026-07-01).
    const res = await server.inject({
      method: 'PUT',
      url: `/api/hosts/${id}`,
      payload: { commissionedAt: '2026-07-01' },
    });

    expect(res.statusCode).toBe(200);
    const after = await readHost(id);
    expect(after.provisional).toBe(false);
    expect(after.commissionedAt).toBe('2026-07-01');
  });
});

describe('POST /api/hosts/confirm-commissioning (bulk, transactional)', () => {
  let clusterId: string;
  beforeEach(async () => {
    clusterId = (await makeCluster(prisma)).id;
  });

  it('confirms per-host dates and clears every flag in one request', async () => {
    const a = await provisionalHost(clusterId);
    const b = await provisionalHost(clusterId);

    const res = await server.inject({
      method: 'POST',
      url: '/api/hosts/confirm-commissioning',
      payload: {
        hosts: [
          { hostId: a, commissionedAt: '2020-01-01' },
          { hostId: b, commissionedAt: '2019-06-15' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      id: string;
      commissionedAt: string;
      commissionedAtProvisional: boolean;
    }>;
    expect(body).toHaveLength(2);
    expect(body.every((h) => h.commissionedAtProvisional === false)).toBe(true);

    expect(await readHost(a)).toEqual({ commissionedAt: '2020-01-01', provisional: false });
    expect(await readHost(b)).toEqual({ commissionedAt: '2019-06-15', provisional: false });
  });

  it('one bad date aborts the whole batch — nothing is committed', async () => {
    // `bad` carries a capacity row at 2026-07-01, so a date after it is rejected.
    const good = await provisionalHost(clusterId, {
      commissionedAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const bad = await provisionalHost(clusterId, {
      commissionedAt: new Date('2026-07-01T00:00:00.000Z'),
      withCapacityAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    const res = await server.inject({
      method: 'POST',
      url: '/api/hosts/confirm-commissioning',
      payload: {
        hosts: [
          // `good` comes first and would succeed on its own — proving rollback.
          { hostId: good, commissionedAt: '2020-01-01' },
          { hostId: bad, commissionedAt: '2027-01-01' },
        ],
      },
    });

    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_COMMISSIONED_AT');

    // The valid host is untouched: the transaction rolled its write back.
    expect(await readHost(good)).toEqual({ commissionedAt: '2026-07-01', provisional: true });
    expect(await readHost(bad)).toEqual({ commissionedAt: '2026-07-01', provisional: true });
  });

  it('rejects a duplicated hostId (400) without mutating it', async () => {
    const id = await provisionalHost(clusterId, {
      commissionedAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    const res = await server.inject({
      method: 'POST',
      url: '/api/hosts/confirm-commissioning',
      payload: {
        hosts: [
          { hostId: id, commissionedAt: '2020-01-01' },
          { hostId: id, commissionedAt: '2021-01-01' },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(await readHost(id)).toEqual({ commissionedAt: '2026-07-01', provisional: true });
  });

  it('an unknown host aborts the batch (404) — the valid host is untouched', async () => {
    const good = await provisionalHost(clusterId, {
      commissionedAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    const res = await server.inject({
      method: 'POST',
      url: '/api/hosts/confirm-commissioning',
      payload: {
        hosts: [
          { hostId: good, commissionedAt: '2020-01-01' },
          { hostId: 'does-not-exist', commissionedAt: '2020-01-01' },
        ],
      },
    });

    expect(res.statusCode).toBe(404);
    expect(await readHost(good)).toEqual({ commissionedAt: '2026-07-01', provisional: true });
  });
});

describe('⚠️ re-sync NEVER overwrites an operator-confirmed commissionedAt', () => {
  const connections = new VsphereConnectionsService(prisma, randomBytes(32));
  const made: string[] = [];
  const CREDS = {
    hostname: 'vcenter.corp.local',
    username: 'u',
    password: 'p',
    pinnedRootPem: null,
  };

  function inventory(): CollectedInventory {
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
    };
  }

  const fakeCollector = (inv: CollectedInventory): VsphereInventoryCollector => ({
    collect: async () => inv,
  });

  afterEach(async () => {
    // beforeEach wipes clusters/hosts (cascade); connections persist, so tidy up.
    if (made.length) {
      await prisma.host.deleteMany({ where: { connectionId: { in: made } } });
      await prisma.cluster.deleteMany({ where: { connectionId: { in: made } } });
      await prisma.vsphereConnection.deleteMany({ where: { id: { in: made.splice(0) } } });
    }
  });

  it('a confirmed date and cleared flag survive a subsequent sync', async () => {
    const conn = await connections.create('default', {
      name: `hc-conn-${Date.now()}`,
      hostname: 'vcenter.corp.local',
      username: 'u',
      password: 'p',
      enabled: true,
    });
    made.push(conn.id);

    const sync = new VsphereSyncService(prisma, fakeCollector(inventory()));
    await sync.syncConnection('default', conn.id, CREDS);

    const created = await prisma.host.findFirstOrThrow({ where: { connectionId: conn.id } });
    expect(created.commissionedAtProvisional).toBe(true);

    // The admin confirms the real date via the ordinary update path.
    const hosts = new HostsService(prisma);
    await hosts.update('default', created.id, {
      commissionedAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    // vCenter reports the same host again — the label/lastSyncedAt update, but the
    // operator-owned commissioning date and cleared flag must be untouched.
    const second = await sync.syncConnection('default', conn.id, CREDS);
    expect(second.hostsUpdated).toBe(1);

    const after = await prisma.host.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.commissionedAt.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(after.commissionedAtProvisional).toBe(false);
    // Proof the sync actually ran over this row.
    expect(after.lastSyncedAt).not.toBeNull();
  });
});
