import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../plugins/auth.js';
import { buildServer } from '../server.js';
import { ForecastService } from '../services/forecast-loader.js';
import { HostsService } from '../services/hosts.js';
import { SessionService } from '../services/sessions.js';

import { makeCluster, makeHost } from './factories.js';
import { prisma } from './setup.js';
import { makeOidcTestEnv, makeTestEnv } from './test-helpers.js';

/**
 * Move a host between clusters with a TIME-SCOPED membership (#289).
 *
 * The high-risk core is forecast attribution: a move must credit the OLD cluster
 * before the move date and the NEW cluster on/after it, and must NOT retroactively
 * rewrite either cluster's earlier months (the landmine of a naive `clusterId`
 * flip). These tests pin exactly that, plus the sync-ownership guard, the RBAC
 * gate, and the one-open/contiguous membership invariant.
 */

const TENANT = 'default';
const utc = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));

/** A 32-byte key so an oidc-mode server actually lands in oidc mode (see auth-plugin.test.ts). */
const CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
function oidcEnv(): ReturnType<typeof makeOidcTestEnv> {
  return makeOidcTestEnv({ CONFIG_ENCRYPTION_KEY });
}

function capacityInMonth(
  months: Array<{ month: string; capacity: number }>,
  label: string,
): number {
  const point = months.find((m) => m.month === label);
  if (!point) throw new Error(`month ${label} not present in forecast`);
  return point.capacity;
}

describe('host move — forecast attribution (#289)', () => {
  const hosts = new HostsService(prisma);
  const forecasts = new ForecastService(prisma);

  const from = utc(2026, 4, 1);
  const to = utc(2026, 8, 1);
  const moveDate = utc(2026, 6, 1);
  const monthsFor = async (clusterId: string) =>
    (await forecasts.forCluster(TENANT, clusterId, 'memory_gb', { fromMonth: from, toMonth: to }))
      .months;

  it('splits a host’s capacity at the move date and leaves the pre-move months unchanged for both clusters', async () => {
    const source = await makeCluster(prisma, { name: 'move-src', baselineCapacity: 0 });
    const target = await makeCluster(prisma, { name: 'move-dst', baselineCapacity: 0 });
    const host = await makeHost(prisma, {
      clusterId: source.id,
      commissionedAt: utc(2026, 1, 1),
      initialCapacity: [{ effectiveFrom: utc(2026, 1, 1), amount: 512 }],
    });

    // Baseline (pre-move): the host lives entirely in the source cluster.
    const srcBefore = await monthsFor(source.id);
    const dstBefore = await monthsFor(target.id);
    expect(capacityInMonth(srcBefore, '2026-04-01')).toBe(512);
    expect(capacityInMonth(srcBefore, '2026-05-01')).toBe(512);
    expect(capacityInMonth(srcBefore, '2026-06-01')).toBe(512);
    expect(capacityInMonth(dstBefore, '2026-06-01')).toBe(0);

    await hosts.move(TENANT, host.id, { clusterId: target.id, moveDate });

    const srcAfter = await monthsFor(source.id);
    const dstAfter = await monthsFor(target.id);

    // (a) attribution splits exactly at the move date.
    expect(capacityInMonth(srcAfter, '2026-05-01')).toBe(512); // month before move → still source
    expect(capacityInMonth(srcAfter, '2026-06-01')).toBe(0); // move month → left source
    expect(capacityInMonth(dstAfter, '2026-05-01')).toBe(0); // month before move → not yet target
    expect(capacityInMonth(dstAfter, '2026-06-01')).toBe(512); // move month → now target
    expect(capacityInMonth(dstAfter, '2026-08-01')).toBe(512);

    // (b) months BEFORE the move are byte-identical before vs. after the move —
    // for BOTH clusters. History is not retroactively rewritten.
    const preMove = ['2026-04-01', '2026-05-01'];
    for (const label of preMove) {
      expect(srcAfter.find((m) => m.month === label)).toEqual(
        srcBefore.find((m) => m.month === label),
      );
      expect(dstAfter.find((m) => m.month === label)).toEqual(
        dstBefore.find((m) => m.month === label),
      );
    }
  });

  it('keeps every capacity row FK’d to the host — none are moved or recreated', async () => {
    const source = await makeCluster(prisma, { name: 'keep-src', baselineCapacity: 0 });
    const target = await makeCluster(prisma, { name: 'keep-dst', baselineCapacity: 0 });
    const host = await makeHost(prisma, {
      clusterId: source.id,
      commissionedAt: utc(2026, 1, 1),
      initialCapacity: [
        { effectiveFrom: utc(2026, 1, 1), amount: 512 },
        { effectiveFrom: utc(2026, 3, 1), amount: 640 },
      ],
    });
    const before = await prisma.hostMetricCapacity.findMany({ where: { hostId: host.id } });

    await hosts.move(TENANT, host.id, { clusterId: target.id, moveDate });

    const after = await prisma.hostMetricCapacity.findMany({ where: { hostId: host.id } });
    expect(after.map((c) => c.id).sort()).toEqual(before.map((c) => c.id).sort());
  });

  it('maintains exactly one open membership, contiguous and non-overlapping', async () => {
    const source = await makeCluster(prisma, { name: 'inv-src', baselineCapacity: 0 });
    const target = await makeCluster(prisma, { name: 'inv-dst', baselineCapacity: 0 });
    const host = await makeHost(prisma, {
      clusterId: source.id,
      commissionedAt: utc(2026, 1, 1),
    });

    await hosts.move(TENANT, host.id, { clusterId: target.id, moveDate });

    const rows = await prisma.hostClusterMembership.findMany({
      where: { hostId: host.id },
      orderBy: { effectiveFrom: 'asc' },
    });
    expect(rows).toHaveLength(2);
    // closed source interval, then open target interval
    expect(rows[0]!.clusterId).toBe(source.id);
    expect(rows[0]!.effectiveFrom.getTime()).toBe(utc(2026, 1, 1).getTime());
    expect(rows[0]!.effectiveTo?.getTime()).toBe(moveDate.getTime());
    expect(rows[1]!.clusterId).toBe(target.id);
    expect(rows[1]!.effectiveFrom.getTime()).toBe(moveDate.getTime());
    expect(rows[1]!.effectiveTo).toBeNull();
    // contiguous: the closed interval ends exactly where the open one begins
    expect(rows[0]!.effectiveTo!.getTime()).toBe(rows[1]!.effectiveFrom.getTime());
    // exactly one open row
    expect(rows.filter((r) => r.effectiveTo === null)).toHaveLength(1);
    // the denormalised pointer tracks the open membership
    const moved = await prisma.host.findFirstOrThrow({ where: { id: host.id } });
    expect(moved.clusterId).toBe(target.id);
  });

  it('supports move A→B→A, attributing each interval to the right cluster', async () => {
    const a = await makeCluster(prisma, { name: 'aba-a', baselineCapacity: 0 });
    const b = await makeCluster(prisma, { name: 'aba-b', baselineCapacity: 0 });
    const host = await makeHost(prisma, {
      clusterId: a.id,
      commissionedAt: utc(2026, 1, 1),
      initialCapacity: [{ effectiveFrom: utc(2026, 1, 1), amount: 512 }],
    });

    await hosts.move(TENANT, host.id, { clusterId: b.id, moveDate: utc(2026, 5, 1) });
    await hosts.move(TENANT, host.id, { clusterId: a.id, moveDate: utc(2026, 7, 1) });

    const aMonths = await monthsFor(a.id);
    const bMonths = await monthsFor(b.id);
    // A holds it before May and again from July; B holds it May–June.
    expect(capacityInMonth(aMonths, '2026-04-01')).toBe(512);
    expect(capacityInMonth(aMonths, '2026-05-01')).toBe(0);
    expect(capacityInMonth(aMonths, '2026-06-01')).toBe(0);
    expect(capacityInMonth(aMonths, '2026-07-01')).toBe(512);
    expect(capacityInMonth(bMonths, '2026-05-01')).toBe(512);
    expect(capacityInMonth(bMonths, '2026-06-01')).toBe(512);
    expect(capacityInMonth(bMonths, '2026-07-01')).toBe(0);
  });

  it('makes the previously-stranding same-month double move well-defined — the intermediate cluster keeps a full month (#289)', async () => {
    // Review finding: two moves in one calendar month (A→B→C) stranded B at
    // capacity 0 for EVERY month. With `moveDate` constrained to the first of a
    // month AND the `moveDate > current-start` guard, a second move cannot land in
    // the same month — so B always holds the host for at least one full month.
    const a = await makeCluster(prisma, { name: 'strand-a', baselineCapacity: 0 });
    const b = await makeCluster(prisma, { name: 'strand-b', baselineCapacity: 0 });
    const c = await makeCluster(prisma, { name: 'strand-c', baselineCapacity: 0 });
    const host = await makeHost(prisma, {
      clusterId: a.id,
      commissionedAt: utc(2026, 1, 1),
      initialCapacity: [{ effectiveFrom: utc(2026, 1, 1), amount: 512 }],
    });

    await hosts.move(TENANT, host.id, { clusterId: b.id, moveDate: utc(2026, 6, 1) });
    // A second move dated in the SAME calendar month is refused — this is what
    // prevents the zero-length interval that stranded B before.
    await expect(
      hosts.move(TENANT, host.id, { clusterId: c.id, moveDate: utc(2026, 6, 1) }),
    ).rejects.toMatchObject({ code: 'INVALID_MOVE_DATE', statusCode: 422 });

    // The well-defined correction is the next first-of-month; B keeps all of June.
    await hosts.move(TENANT, host.id, { clusterId: c.id, moveDate: utc(2026, 7, 1) });

    const bMonths = await monthsFor(b.id);
    const cMonths = await monthsFor(c.id);
    expect(capacityInMonth(bMonths, '2026-06-01')).toBe(512); // B is NOT stranded
    expect(capacityInMonth(bMonths, '2026-07-01')).toBe(0);
    expect(capacityInMonth(cMonths, '2026-06-01')).toBe(0);
    expect(capacityInMonth(cMonths, '2026-07-01')).toBe(512);
  });
});

describe('host move — service guards (#289)', () => {
  const hosts = new HostsService(prisma);

  it('rejects moving a SYNCED host with SYNC_OWNED_FIELD (409)', async () => {
    const source = await makeCluster(prisma, { name: 'g-src' });
    const target = await makeCluster(prisma, { name: 'g-dst' });
    const host = await makeHost(prisma, { clusterId: source.id, source: 'vsphere' });

    await expect(
      hosts.move(TENANT, host.id, { clusterId: target.id, moveDate: utc(2026, 6, 1) }),
    ).rejects.toMatchObject({ code: 'SYNC_OWNED_FIELD', statusCode: 409 });
  });

  it('rejects moving a host INTO a synced destination cluster with SYNC_OWNED_FIELD (409)', async () => {
    const source = await makeCluster(prisma, { name: 'g-src2' });
    const target = await makeCluster(prisma, { name: 'g-dst2', source: 'vsphere' });
    const host = await makeHost(prisma, { clusterId: source.id });

    await expect(
      hosts.move(TENANT, host.id, { clusterId: target.id, moveDate: utc(2026, 6, 1) }),
    ).rejects.toMatchObject({ code: 'SYNC_OWNED_FIELD', statusCode: 409 });
  });

  it('rejects a move to the SAME cluster with HOST_ALREADY_IN_CLUSTER (422)', async () => {
    const source = await makeCluster(prisma, { name: 'g-same' });
    const host = await makeHost(prisma, { clusterId: source.id });

    await expect(
      hosts.move(TENANT, host.id, { clusterId: source.id, moveDate: utc(2026, 6, 1) }),
    ).rejects.toMatchObject({ code: 'HOST_ALREADY_IN_CLUSTER', statusCode: 422 });
  });

  it('rejects a move dated on/before the current membership start with INVALID_MOVE_DATE (422)', async () => {
    const source = await makeCluster(prisma, { name: 'g-date-src' });
    const target = await makeCluster(prisma, { name: 'g-date-dst' });
    const host = await makeHost(prisma, { clusterId: source.id, commissionedAt: utc(2026, 3, 1) });

    await expect(
      hosts.move(TENANT, host.id, { clusterId: target.id, moveDate: utc(2026, 3, 1) }),
    ).rejects.toMatchObject({ code: 'INVALID_MOVE_DATE', statusCode: 422 });
    await expect(
      hosts.move(TENANT, host.id, { clusterId: target.id, moveDate: utc(2026, 2, 1) }),
    ).rejects.toMatchObject({ code: 'INVALID_MOVE_DATE', statusCode: 422 });
  });

  it('404s an unknown host and an unknown destination cluster', async () => {
    const source = await makeCluster(prisma, { name: 'g-404' });
    const host = await makeHost(prisma, { clusterId: source.id });

    await expect(
      hosts.move(TENANT, 'nonexistent-host-id', {
        clusterId: source.id,
        moveDate: utc(2026, 6, 1),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      hosts.move(TENANT, host.id, {
        clusterId: 'nonexistent-cluster-id',
        moveDate: utc(2026, 6, 1),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('host commissionedAt correction vs the membership timeline (#289)', () => {
  const hosts = new HostsService(prisma);

  // Sets up a MOVED host whose earliest interval is closed at the move date and
  // whose first capacity row deliberately postdates commissioning — the exact
  // shape that lets a later `commissionedAt` slip past the capacity-row guard.
  async function movedHostWithLateCapacity(): Promise<string> {
    const a = await makeCluster(prisma, {
      name: `realign-a-${Math.random()}`,
      baselineCapacity: 0,
    });
    const b = await makeCluster(prisma, {
      name: `realign-b-${Math.random()}`,
      baselineCapacity: 0,
    });
    const host = await makeHost(prisma, {
      clusterId: a.id,
      commissionedAt: utc(2026, 3, 1),
      // First capacity row postdates commissioning, so a commissionedAt correction
      // up to 2026-05-01 passes the "not after the earliest capacity row" guard.
      initialCapacity: [{ effectiveFrom: utc(2026, 5, 1), amount: 512 }],
    });
    // Earliest interval is now closed: [2026-03-01, 2026-04-01) in A.
    await hosts.move(TENANT, host.id, { clusterId: b.id, moveDate: utc(2026, 4, 1) });
    return host.id;
  }

  it('rejects a commissionedAt correction that would invert the earliest interval', async () => {
    const hostId = await movedHostWithLateCapacity();

    // 2026-05-01 is >= the earliest interval's end (2026-04-01): applying it would
    // write effectiveFrom(05-01) > effectiveTo(04-01). Must be rejected, not written.
    await expect(
      hosts.update(TENANT, hostId, { commissionedAt: utc(2026, 5, 1) }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMISSIONED_AT', statusCode: 422 });

    // The timeline is untouched — the earliest interval is still valid (from < to).
    const rows = await prisma.hostClusterMembership.findMany({
      where: { hostId },
      orderBy: { effectiveFrom: 'asc' },
    });
    expect(rows[0]!.effectiveFrom.getTime()).toBe(utc(2026, 3, 1).getTime());
    expect(rows[0]!.effectiveTo!.getTime()).toBe(utc(2026, 4, 1).getTime());
    expect(rows[0]!.effectiveFrom.getTime()).toBeLessThan(rows[0]!.effectiveTo!.getTime());
  });

  it('still allows an EARLIER commissionedAt correction, realigning the earliest interval', async () => {
    const hostId = await movedHostWithLateCapacity();

    await hosts.update(TENANT, hostId, { commissionedAt: utc(2026, 2, 1) });

    const rows = await prisma.hostClusterMembership.findMany({
      where: { hostId },
      orderBy: { effectiveFrom: 'asc' },
    });
    // Earliest interval start moved back with the correction; end is unchanged.
    expect(rows[0]!.effectiveFrom.getTime()).toBe(utc(2026, 2, 1).getTime());
    expect(rows[0]!.effectiveTo!.getTime()).toBe(utc(2026, 4, 1).getTime());
  });
});

describe('POST /api/hosts/:id/move — route + RBAC (#289)', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildServer({ env: makeTestEnv(), prisma });
  });
  afterAll(async () => {
    await server.close();
  });

  it('moves the host and returns it under the new cluster (200)', async () => {
    const source = await makeCluster(prisma, { name: 'r-src' });
    const target = await makeCluster(prisma, { name: 'r-dst' });
    const host = await makeHost(prisma, { clusterId: source.id, commissionedAt: utc(2026, 1, 1) });

    const res = await server.inject({
      method: 'POST',
      url: `/api/hosts/${host.id}/move`,
      payload: { clusterId: target.id, moveDate: '2026-06-01' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().clusterId).toBe(target.id);
    const open = await prisma.hostClusterMembership.findFirst({
      where: { hostId: host.id, effectiveTo: null },
    });
    expect(open?.clusterId).toBe(target.id);
  });

  it('rejects a synced host over the wire with a 409 SYNC_OWNED_FIELD envelope', async () => {
    const source = await makeCluster(prisma, { name: 'r-sync-src' });
    const target = await makeCluster(prisma, { name: 'r-sync-dst' });
    const host = await makeHost(prisma, { clusterId: source.id, source: 'vsphere' });

    const res = await server.inject({
      method: 'POST',
      url: `/api/hosts/${host.id}/move`,
      payload: { clusterId: target.id, moveDate: '2026-06-01' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SYNC_OWNED_FIELD');
  });

  it('rejects a malformed body (missing moveDate) with 400', async () => {
    const source = await makeCluster(prisma, { name: 'r-bad-src' });
    const target = await makeCluster(prisma, { name: 'r-bad-dst' });
    const host = await makeHost(prisma, { clusterId: source.id });

    const res = await server.inject({
      method: 'POST',
      url: `/api/hosts/${host.id}/move`,
      payload: { clusterId: target.id },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-first-of-month moveDate with 400 (engine granularity)', async () => {
    const source = await makeCluster(prisma, { name: 'r-mid-src' });
    const target = await makeCluster(prisma, { name: 'r-mid-dst' });
    const host = await makeHost(prisma, { clusterId: source.id });

    const res = await server.inject({
      method: 'POST',
      url: `/api/hosts/${host.id}/move`,
      payload: { clusterId: target.id, moveDate: '2026-06-15' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 403 FORBIDDEN when a VIEWER attempts the move', async () => {
    const source = await makeCluster(prisma, { name: 'r-viewer-src' });
    const target = await makeCluster(prisma, { name: 'r-viewer-dst' });
    const host = await makeHost(prisma, { clusterId: source.id });

    const viewer = await prisma.user.create({
      data: {
        issuer: 'https://idp.test',
        subject: 'sub-viewer-move',
        email: 'viewer-move@example.com',
        role: 'VIEWER',
      },
    });
    const { token } = await new SessionService(prisma).create(viewer.id, 12);
    const oidcServer = await buildServer({ env: oidcEnv(), prisma });
    try {
      const res = await oidcServer.inject({
        method: 'POST',
        url: `/api/hosts/${host.id}/move`,
        cookies: { [SESSION_COOKIE]: token },
        payload: { clusterId: target.id, moveDate: '2026-06-01' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
      // The move never happened.
      const stillSource = await prisma.host.findFirstOrThrow({ where: { id: host.id } });
      expect(stillSource.clusterId).toBe(source.id);
    } finally {
      await oidcServer.close();
    }
  });
});
