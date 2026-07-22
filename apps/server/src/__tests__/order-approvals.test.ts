import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../plugins/auth.js';
import { SessionService } from '../services/sessions.js';
import { SettingsService } from '../services/settings.js';
import { buildServer } from '../server.js';
import { makeCluster, makeHost } from './factories.js';
import { prisma } from './setup.js';
import { makeOidcTestEnv, makeTestEnv } from './test-helpers.js';

/**
 * Order-approval integration tests (#292, DESIGN.md §10). Real Postgres via the
 * shared Testcontainer. `disabledServer` runs `AUTH_MODE=disabled` (anonymous
 * ADMIN); the RBAC cases spin up short-lived oidc servers.
 */

const ANCHOR = new Date('2026-05-01T00:00:00.000Z');

/**
 * A valid 32-byte key so a server built from `makeOidcTestEnv` actually lands in
 * oidc mode — without it the auth-config plugin's missing-key fail-safe forces
 * mode=disabled (anonymous ADMIN), which would silently defeat the RBAC cases.
 * Same rationale as `auth-plugin.test.ts`.
 */
const CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
function oidcEnv(): ReturnType<typeof makeOidcTestEnv> {
  return makeOidcTestEnv({ CONFIG_ENCRYPTION_KEY });
}

interface ForecastBody {
  procurement: { orderByDate: string | null; breachMonth: string | null; leadTimeWeeks: number };
  acknowledgment: { note: string | null; approvedByLabel: string; approvedAt: string } | null;
}

interface ApprovalBody {
  id: string;
  clusterId: string;
  breachMonth: string;
  orderByDate: string;
  leadTimeWeeks: number;
  warnThreshold: number;
  capacitySignature: number;
  approvedByUserId: string | null;
  approvedByLabel: string;
  note: string | null;
  createdAt: string;
}

let disabledServer: FastifyInstance;
const oidcServers: FastifyInstance[] = [];

/** A cluster whose live forecast is over the warn threshold (util 0.8). */
async function breachingCluster(hostCapacity = 10_000): Promise<string> {
  const cluster = await makeCluster(prisma, { baselineConsumption: 8000, baselineCapacity: 0 });
  await makeHost(prisma, {
    clusterId: cluster.id,
    commissionedAt: ANCHOR,
    initialCapacity: [{ effectiveFrom: ANCHOR, amount: hostCapacity }],
  });
  return cluster.id;
}

/** A cluster whose live forecast never crosses warn (util 0.1). */
async function healthyCluster(): Promise<string> {
  const cluster = await makeCluster(prisma, { baselineConsumption: 1000, baselineCapacity: 0 });
  await makeHost(prisma, {
    clusterId: cluster.id,
    commissionedAt: ANCHOR,
    initialCapacity: [{ effectiveFrom: ANCHOR, amount: 10_000 }],
  });
  return cluster.id;
}

function approve(clusterId: string, note?: string) {
  return disabledServer.inject({
    method: 'POST',
    url: `/api/clusters/${clusterId}/order-approvals`,
    payload: note === undefined ? {} : { note },
  });
}

function getForecast(clusterId: string) {
  return disabledServer.inject({
    method: 'GET',
    url: `/api/clusters/${clusterId}/forecast?metric=memory_gb`,
  });
}

async function setLeadTimeWeeks(weeks: number): Promise<void> {
  await new SettingsService(prisma).updateTenant('default', {
    warnThreshold: 0.7,
    critThreshold: 0.9,
    procurementLeadTimeWeeks: weeks,
    idempotencyKeyRetentionHours: 24,
  });
}

beforeAll(async () => {
  disabledServer = await buildServer({ env: makeTestEnv(), prisma });
});

afterEach(async () => {
  await prisma.orderApproval.deleteMany({});
});

afterAll(async () => {
  await disabledServer.close();
  await Promise.all(oidcServers.map((s) => s.close()));
});

describe('POST /api/clusters/:id/order-approvals', () => {
  it('snapshots the live breach and returns 201', async () => {
    const clusterId = await breachingCluster();

    const res = await approve(clusterId, 'ordered — 2 nodes');
    expect(res.statusCode).toBe(201);

    const body = res.json() as ApprovalBody;
    expect(body).toMatchObject({
      clusterId,
      breachMonth: '2026-05-01',
      leadTimeWeeks: 8,
      warnThreshold: 0.7,
      capacitySignature: 10_000,
      note: 'ordered — 2 nodes',
      // Disabled mode: no users row, audit carried by the label (DESIGN.md §7).
      approvedByUserId: null,
      approvedByLabel: 'anonymous (auth disabled)',
    });
    // orderByDate = first-of-breach-month − 8 weeks.
    expect(body.orderByDate).toBe('2026-03-06');
  });

  it('returns 422 when there is no live breach', async () => {
    const clusterId = await healthyCluster();
    const res = await approve(clusterId);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('NO_LIVE_BREACH');
  });

  it('records approvedByUserId + a human label for a real ADMIN (oidc)', async () => {
    const clusterId = await breachingCluster();
    const user = await prisma.user.create({
      data: {
        issuer: 'https://idp.test',
        subject: 'sub-admin-292',
        email: 'admin@example.com',
        displayName: 'Ada Admin',
        role: 'ADMIN',
      },
    });
    const { token } = await new SessionService(prisma).create(user.id, 12);
    const server = await buildServer({ env: oidcEnv(), prisma });
    oidcServers.push(server);

    const res = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/order-approvals`,
      cookies: { [SESSION_COOKIE]: token },
      payload: { note: 'signed off' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as ApprovalBody;
    expect(body.approvedByUserId).toBe(user.id);
    expect(body.approvedByLabel).toBe('Ada Admin');
  });

  it('returns 403 when a VIEWER attempts to approve', async () => {
    const clusterId = await breachingCluster();
    const viewer = await prisma.user.create({
      data: {
        issuer: 'https://idp.test',
        subject: 'sub-viewer-292',
        email: 'viewer@example.com',
        role: 'VIEWER',
      },
    });
    const { token } = await new SessionService(prisma).create(viewer.id, 12);
    const server = await buildServer({ env: oidcEnv(), prisma });
    oidcServers.push(server);

    const res = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/order-approvals`,
      cookies: { [SESSION_COOKIE]: token },
      payload: { note: 'nope' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});

describe('forecast acknowledgment coverage (DESIGN.md §3)', () => {
  it('is null before any approval, populated after', async () => {
    const clusterId = await breachingCluster();

    const before = (await getForecast(clusterId)).json() as ForecastBody;
    expect(before.acknowledgment).toBeNull();

    await approve(clusterId, 'seen it, plan in place');

    const after = (await getForecast(clusterId)).json() as ForecastBody;
    expect(after.acknowledgment).toMatchObject({
      note: 'seen it, plan in place',
      approvedByLabel: 'anonymous (auth disabled)',
    });
    expect(after.acknowledgment?.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('supersedes when a host is added (capacity signature changes) — INV-2', async () => {
    const clusterId = await breachingCluster();
    await approve(clusterId);
    expect((await getForecast(clusterId)).json().acknowledgment).not.toBeNull();

    // A small extra host keeps the breach (util 8000/10500 = 0.76 ≥ 0.7) but
    // moves the capacity signature, so the approval no longer covers it.
    await makeHost(prisma, {
      clusterId,
      commissionedAt: ANCHOR,
      initialCapacity: [{ effectiveFrom: ANCHOR, amount: 500 }],
    });

    const after = (await getForecast(clusterId)).json() as ForecastBody;
    expect(after.procurement.orderByDate).not.toBeNull(); // breach still live
    expect(after.acknowledgment).toBeNull();
  });

  it('supersedes when the warn threshold changes — INV-2', async () => {
    const clusterId = await breachingCluster();
    await approve(clusterId);
    expect((await getForecast(clusterId)).json().acknowledgment).not.toBeNull();

    await new SettingsService(prisma).updateTenant('default', {
      warnThreshold: 0.6,
      critThreshold: 0.9,
      procurementLeadTimeWeeks: 8,
      idempotencyKeyRetentionHours: 24,
    });

    expect((await getForecast(clusterId)).json().acknowledgment).toBeNull();
  });

  it('stays acknowledged when the breach drifts earlier by < T — INV-5', async () => {
    const clusterId = await breachingCluster();
    await approve(clusterId); // leadTime 8 → orderByDate 2026-03-06
    // +2 weeks lead ⇒ orderByDate 14 days earlier (< 31), no capacity/threshold change.
    await setLeadTimeWeeks(10);

    const body = (await getForecast(clusterId)).json() as ForecastBody;
    expect(body.procurement.leadTimeWeeks).toBe(10);
    expect(body.acknowledgment).not.toBeNull();
  });

  it('supersedes when the breach drifts earlier by ≥ T — INV-5', async () => {
    const clusterId = await breachingCluster();
    await approve(clusterId); // leadTime 8
    // +6 weeks lead ⇒ orderByDate 42 days earlier (≥ 31) with no capacity/threshold change.
    await setLeadTimeWeeks(14);

    const body = (await getForecast(clusterId)).json() as ForecastBody;
    expect(body.procurement.leadTimeWeeks).toBe(14);
    expect(body.acknowledgment).toBeNull();
  });

  it('stays acknowledged when the breach drifts later (improving) — INV-5', async () => {
    const clusterId = await breachingCluster();
    await approve(clusterId); // leadTime 8
    // −2 weeks lead ⇒ orderByDate 14 days LATER; improving never supersedes.
    await setLeadTimeWeeks(6);

    expect((await getForecast(clusterId)).json().acknowledgment).not.toBeNull();
  });

  it('does not surface an acknowledgment once the breach clears — INV-3', async () => {
    const clusterId = await breachingCluster();
    await approve(clusterId);
    expect((await getForecast(clusterId)).json().acknowledgment).not.toBeNull();

    // Add enough capacity to drop util below warn (8000 / 20000 = 0.4).
    await makeHost(prisma, {
      clusterId,
      commissionedAt: ANCHOR,
      initialCapacity: [{ effectiveFrom: ANCHOR, amount: 10_000 }],
    });

    const body = (await getForecast(clusterId)).json() as ForecastBody;
    expect(body.procurement.orderByDate).toBeNull();
    expect(body.acknowledgment).toBeNull();
  });

  it('keeps approvals annotation-only — no effect on the forecast numbers (INV-1)', async () => {
    const clusterId = await breachingCluster();
    const before = (await getForecast(clusterId)).json() as ForecastBody & {
      months: unknown[];
      procurement: unknown;
    };
    await approve(clusterId, 'annotation');
    const after = (await getForecast(clusterId)).json() as typeof before;

    expect(after.months).toEqual(before.months);
    expect(after.procurement).toEqual(before.procurement);
  });
});
