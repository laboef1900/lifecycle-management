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
  metricTypeId: string | null;
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

/**
 * A cluster whose newest baseline is dated ~9 months in the FUTURE, but whose
 * only host was commissioned in the past and is already breaching (util 0.8).
 * Future-dated baselines are accepted with no upper bound (forecast-loader.ts
 * anchor `@ai-warning`), so the SERVER DEFAULT (baseline-anchored) write window
 * starts ~9 months later than the chip's today-anchored read window — the exact
 * #303 repro.
 */
async function futureBaselineBreachingCluster(baselineConsumption = 8000): Promise<string> {
  const now = new Date();
  const futureBaseline = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 9, 1));
  // Well in the past, so the host is active across BOTH the future write window
  // and the today-anchored chip window.
  const past = new Date('2024-01-01T00:00:00.000Z');
  const cluster = await makeCluster(prisma, {
    baselineDate: futureBaseline,
    baselineConsumption,
    baselineCapacity: 0,
  });
  await makeHost(prisma, {
    clusterId: cluster.id,
    commissionedAt: past,
    initialCapacity: [{ effectiveFrom: past, amount: 10_000 }],
  });
  return cluster.id;
}

/** `YYYY-MM` for the first of the UTC month `monthsFromNow` months from now. */
function monthFromNow(monthsFromNow: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsFromNow, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
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
    // The breach is snapshotted for the cluster's primary metric (#292).
    const memoryMetric = await prisma.metricType.findUnique({ where: { key: 'memory_gb' } });

    const res = await approve(clusterId, 'ordered — 2 nodes');
    expect(res.statusCode).toBe(201);

    const body = res.json() as ApprovalBody;
    expect(body).toMatchObject({
      clusterId,
      breachMonth: '2026-05-01',
      leadTimeWeeks: 8,
      warnThreshold: 0.7,
      capacitySignature: 10_000,
      // The primary (and only, in v1) metric's id is captured on the snapshot.
      metricTypeId: memoryMetric?.id,
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

  it('stays acknowledged when the chip reads a today-anchored window that diverges from the baseline-anchored write window (window-divergence fails safe)', async () => {
    // The write path snapshots over the SERVER DEFAULT (baseline-anchored, 2026-05)
    // window; the web chip reads a TODAY-anchored window (resolveWindow's 24-mo
    // view). ANCHOR (2026-05-01) is stale relative to "today", so the two windows
    // diverge. Because the write window starts earliest, the snapshotted
    // orderByDate is never LATER than the live one, so the ≥ T rule can never
    // falsely supersede — the acknowledgment survives the divergence (INV-5,
    // forecast-loader.ts liveBreachContext @ai-warning / DESIGN.md §3).
    const clusterId = await breachingCluster();
    await approve(clusterId, 'seen it');

    const now = new Date();
    const yyyyMm = (d: Date): string =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const from = yyyyMm(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    const to = yyyyMm(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 23, 1)));

    const res = await disabledServer.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=memory_gb&from=${from}&to=${to}`,
    });
    const body = res.json() as ForecastBody;
    // The today-anchored window still shows a live breach (util 0.8 every month)...
    expect(body.procurement.orderByDate).not.toBeNull();
    // ...and the acknowledgment is NOT falsely superseded by the window divergence.
    expect(body.acknowledgment).not.toBeNull();
  });

  it('does not falsely supersede a fresh approval for a future-dated baseline (#303)', async () => {
    // #303 repro: the newest baseline is dated ~9 months out, so the baseline-
    // anchored WRITE window snapshots an orderByDate ~9 months later than the
    // today-anchored chip READ window. Before the write-path anchor is clamped to
    // min(capturedAt, today), the ≥ T supersede rule (INV-5) fires the instant the
    // approval is created and the acknowledgment never appears in the default UI.
    const clusterId = await futureBaselineBreachingCluster();

    const res = await approve(clusterId, 'seen it — parts on order');
    expect(res.statusCode).toBe(201);

    // The chip reads a TODAY-anchored 24-mo window (resolveWindow).
    const from = monthFromNow(0);
    const to = monthFromNow(23);
    const body = (
      await disabledServer.inject({
        method: 'GET',
        url: `/api/clusters/${clusterId}/forecast?metric=memory_gb&from=${from}&to=${to}`,
      })
    ).json() as ForecastBody;

    // The today-anchored window shows a live breach (util 0.8 every month)...
    expect(body.procurement.orderByDate).not.toBeNull();
    // ...and the fresh approval is NOT falsely superseded by the window divergence.
    expect(body.acknowledgment).toMatchObject({ note: 'seen it — parts on order' });
  });

  it('leaves a past-dated baseline unaffected — the clamp is a no-op (#303 regression)', async () => {
    // A normal past-dated anchor (2026-05): min(capturedAt, today) === capturedAt,
    // so the clamp changes nothing. The snapshot is still the baseline-anchored
    // orderByDate, and a genuine ≥ T worsening still supersedes exactly as before.
    const clusterId = await breachingCluster();

    const approval = (await approve(clusterId)).json() as ApprovalBody;
    // Baseline-anchored: first-of-breach-month (2026-05-01) − 8 weeks. Unchanged
    // by the clamp — proof the write path is untouched for past-dated baselines.
    expect(approval.orderByDate).toBe('2026-03-06');
    expect((await getForecast(clusterId)).json().acknowledgment).not.toBeNull();

    // +6 weeks lead ⇒ orderByDate 42 days earlier (≥ 31): the worsening still
    // supersedes, identically to before the fix.
    await setLeadTimeWeeks(14);
    expect((await getForecast(clusterId)).json().acknowledgment).toBeNull();
  });

  it('does not falsely supersede a fresh approval for a future-dated baseline with a borderline breach (#303)', async () => {
    // Same #303 window-divergence repro as above, but the breach is BORDERLINE
    // (util 7100/10_000 = 0.71, a hair over the 0.7 warn threshold) rather than a
    // flat, obviously-breaching 0.8. The clamp fix must hold at the threshold edge
    // too: the write path still snapshots a today-anchored orderByDate, so the ≥ T
    // rule cannot falsely supersede the moment the approval is created.
    const clusterId = await futureBaselineBreachingCluster(7100);

    const res = await approve(clusterId, 'seen it — borderline');
    expect(res.statusCode).toBe(201);

    // The chip reads a TODAY-anchored 24-mo window (resolveWindow).
    const from = monthFromNow(0);
    const to = monthFromNow(23);
    const body = (
      await disabledServer.inject({
        method: 'GET',
        url: `/api/clusters/${clusterId}/forecast?metric=memory_gb&from=${from}&to=${to}`,
      })
    ).json() as ForecastBody;

    // The today-anchored window shows a live (borderline) breach...
    expect(body.procurement.orderByDate).not.toBeNull();
    // ...and the fresh approval is NOT falsely superseded by the window divergence.
    expect(body.acknowledgment).toMatchObject({ note: 'seen it — borderline' });
  });

  it('keeps the acknowledgment current in the baseline-anchored `all` view for a future-dated baseline (write-path-only clamp, #303/#300)', async () => {
    // The clamp is WRITE-PATH ONLY and deliberately does NOT touch the read-path
    // baseline-anchored (`all`) window (the #300 window-alignment rejection). For a
    // FUTURE-dated baseline the default/`all` view stays anchored ~9 months out, so
    // its live orderByDate is LATER than the today-anchored snapshot — a "drifts
    // later / improving" divergence, which never supersedes (INV-5). Assert the
    // acknowledgment therefore lingers as current in that view.
    const clusterId = await futureBaselineBreachingCluster();

    const approval = (await approve(clusterId, 'seen it — all view')).json() as ApprovalBody;
    // The snapshot's orderByDate is TODAY-anchored (clamped), so its breach month is
    // this month — provably earlier than the baseline-anchored `all` view below.
    expect(approval.breachMonth).toBe(`${monthFromNow(0)}-01`);

    // The default forecast (no from/to) IS the baseline-anchored `all` view: for a
    // future baseline it starts ~9 months out, so its live orderByDate is later.
    const body = (await getForecast(clusterId)).json() as ForecastBody;
    expect(body.procurement.orderByDate).not.toBeNull(); // breach still live there
    expect(body.acknowledgment).toMatchObject({ note: 'seen it — all view' });
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
