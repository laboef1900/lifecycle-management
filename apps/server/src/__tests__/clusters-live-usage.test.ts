import { liveUsageListResponseSchema } from '@lcm/shared';
import type { VsphereConnectionStatus } from '@lcm/shared';
import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';

import { makeCluster, makeHost, makeVsphereConnection } from './factories.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

/**
 * Live usage + sync-state serving (#193, epic #172).
 *
 * These assertions are mostly about what the batch endpoint REFUSES to say. A
 * synced cluster with no sample must surface as `never_fetched` (structurally
 * numberless), never as a fabricated 0 — "0% used" is the most dangerous wrong
 * answer in a tool that buys hardware. Manual clusters are ABSENT from the
 * batch, not `never_fetched`: absence is the honest encoding of "no vCenter is
 * involved here".
 */
let server: FastifyInstance;

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});

afterAll(async () => {
  await server.close();
});

const madeConnections: string[] = [];

afterEach(async () => {
  // Our synced clusters/hosts still reference the connection here (setup.ts's
  // cluster wipe runs at the NEXT test's beforeEach, not now), and the FK is
  // Restrict — so drop the referencing rows first, then the connection.
  if (madeConnections.length) {
    const ids = madeConnections.splice(0);
    await prisma.host.deleteMany({ where: { connectionId: { in: ids } } });
    await prisma.cluster.deleteMany({ where: { connectionId: { in: ids } } });
    await prisma.vsphereConnection.deleteMany({ where: { id: { in: ids } } });
  }
});

async function connection(
  opts: Parameters<typeof makeVsphereConnection>[1] = {},
): Promise<{ id: string; name: string }> {
  const conn = await makeVsphereConnection(prisma, opts);
  madeConnections.push(conn.id);
  return conn;
}

/** A synced cluster wired to a fresh connection, with an optional usage sample. */
async function syncedCluster(opts: {
  externalId: string;
  name?: string;
  connectionName?: string;
  connectionStatus?: VsphereConnectionStatus;
  connectionEnabled?: boolean;
  sample?: { memoryUsedGiB: number; hostsSampled: number; hostsTotal: number; measuredAt: Date };
}): Promise<{ clusterId: string; connectionId: string; connectionName: string }> {
  const conn = await connection({
    ...(opts.connectionName !== undefined ? { name: opts.connectionName } : {}),
    ...(opts.connectionStatus !== undefined ? { status: opts.connectionStatus } : {}),
    ...(opts.connectionEnabled !== undefined ? { enabled: opts.connectionEnabled } : {}),
  });
  const cluster = await makeCluster(prisma, {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    source: 'vsphere',
    connectionId: conn.id,
    externalId: opts.externalId,
    externalName: opts.name ?? 'vc-side-name',
    lastSyncedAt: new Date('2026-08-01T00:00:00Z'),
  });
  if (opts.sample) {
    await prisma.vsphereUsageSample.create({
      data: {
        clusterId: cluster.id,
        connectionId: conn.id,
        memoryUsedGiB: new Prisma.Decimal(opts.sample.memoryUsedGiB.toFixed(3)),
        hostsSampled: opts.sample.hostsSampled,
        hostsTotal: opts.sample.hostsTotal,
        measuredAt: opts.sample.measuredAt,
      },
    });
  }
  return { clusterId: cluster.id, connectionId: conn.id, connectionName: conn.name };
}

const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000);

describe('GET /api/clusters/live-usage — batch', () => {
  it('validates against liveUsageListResponseSchema and never yields a null item', async () => {
    await syncedCluster({
      externalId: 'domain-c1',
      sample: { memoryUsedGiB: 1234.5, hostsSampled: 8, hostsTotal: 8, measuredAt: minutesAgo(1) },
    });

    const response = await server.inject({ method: 'GET', url: '/api/clusters/live-usage' });
    expect(response.statusCode).toBe(200);
    // The response boundary itself is the guard: a nullable item would let a
    // renderer reintroduce the 0%-lie the union exists to prevent.
    const parsed = liveUsageListResponseSchema.parse(response.json());
    expect(parsed.items.every((item) => item !== null)).toBe(true);
  });

  it('★ a synced cluster with NO sample is never_fetched — never a fabricated 0', async () => {
    const { clusterId, connectionName } = await syncedCluster({ externalId: 'domain-c1' });

    const response = await server.inject({ method: 'GET', url: '/api/clusters/live-usage' });
    const body = liveUsageListResponseSchema.parse(response.json());
    const item = body.items.find((i) => i.clusterId === clusterId);
    expect(item?.state).toBe('never_fetched');
    // The whole design in one assertion: the number field does not exist, so no
    // consumer can render "0% used" for a cluster we simply have not measured.
    expect(item).not.toHaveProperty('memoryUsedGiB');
    if (item?.state !== 'never_fetched') throw new Error('expected never_fetched');
    expect(item.connectionName).toBe(connectionName);
  });

  it('a synced cluster with a recent sample is fresh and carries the reading', async () => {
    const { clusterId } = await syncedCluster({
      externalId: 'domain-c1',
      sample: { memoryUsedGiB: 987.25, hostsSampled: 6, hostsTotal: 8, measuredAt: minutesAgo(2) },
    });

    const response = await server.inject({ method: 'GET', url: '/api/clusters/live-usage' });
    const item = liveUsageListResponseSchema
      .parse(response.json())
      .items.find((i) => i.clusterId === clusterId);
    expect(item?.state).toBe('fresh');
    if (item?.state !== 'fresh') throw new Error('expected fresh');
    expect(item.memoryUsedGiB).toBe(987.25);
    // 6 of 8 reported — the honest partial-read signal, so a partial read does
    // not read as a real drop in consumption.
    expect(item.hostsSampled).toBe(6);
    expect(item.hostsTotal).toBe(8);
  });

  it('a sample older than 2x the poll interval is stale=unreachable, keeping last-known', async () => {
    const { clusterId } = await syncedCluster({
      externalId: 'domain-c1',
      sample: { memoryUsedGiB: 500, hostsSampled: 4, hostsTotal: 4, measuredAt: minutesAgo(30) },
    });

    const response = await server.inject({ method: 'GET', url: '/api/clusters/live-usage' });
    const item = liveUsageListResponseSchema
      .parse(response.json())
      .items.find((i) => i.clusterId === clusterId);
    expect(item?.state).toBe('stale');
    if (item?.state !== 'stale') throw new Error('expected stale');
    expect(item.reason).toBe('unreachable');
    expect(item.memoryUsedGiB).toBe(500);
  });

  it('a degraded connection reports its distinct reason, not a generic "stale"', async () => {
    const { clusterId } = await syncedCluster({
      externalId: 'domain-c1',
      connectionStatus: 'auth_failed',
      sample: { memoryUsedGiB: 500, hostsSampled: 4, hostsTotal: 4, measuredAt: minutesAgo(1) },
    });

    const response = await server.inject({ method: 'GET', url: '/api/clusters/live-usage' });
    const item = liveUsageListResponseSchema
      .parse(response.json())
      .items.find((i) => i.clusterId === clusterId);
    if (item?.state !== 'stale') throw new Error('expected stale');
    // Collapsing reasons would tell the operator something is wrong but not what
    // to fix — auth_failed needs a credential, unreachable needs the network.
    expect(item.reason).toBe('auth_failed');
  });

  it('★ manual clusters are ABSENT from the batch — not never_fetched', async () => {
    const manual = await makeCluster(prisma, { name: 'manual-cluster' });
    await syncedCluster({ externalId: 'domain-c1', name: 'synced-cluster' });

    const response = await server.inject({ method: 'GET', url: '/api/clusters/live-usage' });
    const body = liveUsageListResponseSchema.parse(response.json());
    // A manual cluster has no connection, so `never_fetched` (which requires a
    // connectionName) cannot represent it. Absence is the honest encoding.
    expect(body.items.some((i) => i.clusterId === manual.id)).toBe(false);
    expect(body.items).toHaveLength(1);
  });

  it('excludes archived synced clusters from the batch', async () => {
    const { clusterId } = await syncedCluster({
      externalId: 'domain-c1',
      sample: { memoryUsedGiB: 100, hostsSampled: 2, hostsTotal: 2, measuredAt: minutesAgo(1) },
    });
    await prisma.cluster.update({ where: { id: clusterId }, data: { archivedAt: new Date() } });

    const response = await server.inject({ method: 'GET', url: '/api/clusters/live-usage' });
    const body = liveUsageListResponseSchema.parse(response.json());
    expect(body.items.some((i) => i.clusterId === clusterId)).toBe(false);
  });
});

describe('GET /api/clusters — sync metadata on ClusterResponse', () => {
  it('a manual cluster reports source=manual with null sync fields and 0 provisional hosts', async () => {
    const manual = await makeCluster(prisma, { name: 'manual-cluster' });
    await makeHost(prisma, { clusterId: manual.id });

    const response = await server.inject({ method: 'GET', url: '/api/clusters' });
    const body = response.json() as { items: Array<Record<string, unknown>> };
    const row = body.items.find((c) => c.id === manual.id);
    expect(row?.source).toBe('manual');
    expect(row?.connection).toBeNull();
    expect(row?.lastSyncedAt).toBeNull();
    expect(row?.externalName).toBeNull();
    expect(row?.provisionalHostCount).toBe(0);
  });

  it('a synced cluster carries source=vsphere, a denormalized connection, and externalName', async () => {
    const { clusterId, connectionId, connectionName } = await syncedCluster({
      externalId: 'domain-c9',
      name: 'prod',
      connectionStatus: 'active',
    });

    const response = await server.inject({ method: 'GET', url: '/api/clusters' });
    const body = response.json() as {
      items: Array<{
        id: string;
        source?: string;
        externalName?: string | null;
        lastSyncedAt?: string | null;
        connection?: { id: string; name: string; status: string; enabled: boolean } | null;
      }>;
    };
    const row = body.items.find((c) => c.id === clusterId);
    expect(row?.source).toBe('vsphere');
    expect(row?.externalName).toBe('prod');
    expect(row?.lastSyncedAt).not.toBeNull();
    expect(row?.connection).toEqual({
      id: connectionId,
      name: connectionName,
      status: 'active',
      enabled: true,
    });
  });

  it('provisionalHostCount counts only hosts with an unconfirmed commissioning date', async () => {
    const { clusterId } = await syncedCluster({ externalId: 'domain-c9' });
    await makeHost(prisma, { clusterId, commissionedAtProvisional: true });
    await makeHost(prisma, { clusterId, commissionedAtProvisional: true });
    await makeHost(prisma, { clusterId, commissionedAtProvisional: false });

    const response = await server.inject({ method: 'GET', url: '/api/clusters' });
    const body = response.json() as { items: Array<{ id: string; provisionalHostCount?: number }> };
    const row = body.items.find((c) => c.id === clusterId);
    expect(row?.provisionalHostCount).toBe(2);
  });
});
