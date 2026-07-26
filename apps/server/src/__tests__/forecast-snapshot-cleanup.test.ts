import { Prisma } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeCluster, makeHost } from './factories.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';
import { forecastSnapshotCleanupPlugin } from '../plugins/forecast-snapshot-cleanup.js';
import { prismaPlugin } from '../plugins/prisma.js';
import { ForecastSnapshotCleanup } from '../services/forecast-snapshot-cleanup.js';
import { ForecastService } from '../services/forecast-loader.js';
import { SettingsService } from '../services/settings.js';
import { buildServer } from '../server.js';

const TENANT = 'default';
const METRIC = 'memory_gb';
const NOW = new Date(Date.UTC(2026, 6, 15)); // mid-month, to prove the cutoff normalizes

function monthStart(offset: number): Date {
  return new Date(Date.UTC(2026, 6 + offset, 1));
}

async function setRetention(months: number, bandEnabled = false): Promise<void> {
  await new SettingsService(prisma).updateTenant(TENANT, {
    warnThreshold: 0.7,
    critThreshold: 0.9,
    procurementLeadTimeWeeks: 8,
    idempotencyKeyRetentionHours: 24,
    forecastUncertaintyBandEnabled: bandEnabled,
    forecastUncertaintyMinAnchors: 6,
    forecastUncertaintyBandWidth: 'p10_p90',
    forecastSnapshotRetentionMonths: months,
  });
}

async function seedSnapshot(
  clusterId: string,
  metricTypeId: string,
  anchor: Date,
  horizon: Date,
  horizonIndex: number,
  util: number,
): Promise<void> {
  await prisma.forecastSnapshot.create({
    data: {
      clusterId,
      metricTypeId,
      tenantId: TENANT,
      anchorMonth: anchor,
      horizonMonth: horizon,
      horizonIndex,
      projectedUtil: new Prisma.Decimal(util),
    },
  });
}

/** 36 monthly anchors, each with its h0 actual and a horizon-1 projection. */
async function seedThreeYears(): Promise<{ id: string; metricTypeId: string }> {
  const cluster = await makeCluster(prisma, {
    baselineDate: monthStart(0),
    baselineConsumption: 100,
    baselineCapacity: 200,
  });
  for (let i = -36; i <= 0; i++) {
    await seedSnapshot(cluster.id, cluster.metricTypeId, monthStart(i), monthStart(i), 0, 0.5);
  }
  for (let i = -36; i <= -1; i++) {
    await seedSnapshot(cluster.id, cluster.metricTypeId, monthStart(i), monthStart(i + 1), 1, 0.6);
  }
  return cluster;
}

/**
 * Two tests below spy on the SHARED `prisma` client. The server suite runs
 * `isolate: false` with a single worker and sets no `restoreMocks`, so a spy
 * that outlives its test stays installed on that client for every remaining
 * file in the run — and the damage surfaces somewhere with no visible link back
 * here. A trailing `mockRestore()` is not enough: it is skipped whenever an
 * assertion above it throws, which is exactly when a test is already failing and
 * least deserves to take the rest of the suite with it.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ForecastSnapshotCleanup (#318)', () => {
  it('deletes NOTHING when retention is off — the default', async () => {
    const { id } = await seedThreeYears();
    await setRetention(0);
    const before = await prisma.forecastSnapshot.count({ where: { clusterId: id } });

    const results = await new ForecastSnapshotCleanup(prisma).sweep(NOW);

    expect(results).toEqual([]);
    expect(await prisma.forecastSnapshot.count({ where: { clusterId: id } })).toBe(before);
  });

  it('never issues a delete at all when every tenant keeps forever', async () => {
    // Stronger than the row count above: proves the safety comes from SKIPPING
    // the tenant, not from a predicate that happens to match nothing.
    await seedThreeYears();
    await setRetention(0);
    const deleteMany = vi.spyOn(prisma.forecastSnapshot, 'deleteMany');

    await new ForecastSnapshotCleanup(prisma).sweep(NOW);

    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('deletes only rows whose horizon month is older than the window', async () => {
    const { id } = await seedThreeYears();
    await setRetention(12);

    const [result] = await new ForecastSnapshotCleanup(prisma).sweep(NOW);

    expect(result).toMatchObject({ tenantId: TENANT, retentionMonths: 12, cutoff: '2025-08-01' });
    expect(result!.deleted).toBeGreaterThan(0);

    const rows = await prisma.forecastSnapshot.findMany({
      where: { clusterId: id },
      select: { horizonMonth: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.horizonMonth.getTime()).toBeGreaterThanOrEqual(Date.UTC(2025, 7, 1));
    }
  });

  it('keeps the boundary month itself — the window is inclusive', async () => {
    const { id } = await seedThreeYears();
    await setRetention(12);

    await new ForecastSnapshotCleanup(prisma).sweep(NOW);

    const boundary = await prisma.forecastSnapshot.findMany({
      where: { clusterId: id, horizonMonth: new Date(Date.UTC(2025, 7, 1)) },
    });
    expect(boundary.length).toBeGreaterThan(0);
  });

  it('is idempotent — a second sweep in the same month deletes nothing more', async () => {
    await seedThreeYears();
    await setRetention(12);
    const cleanup = new ForecastSnapshotCleanup(prisma);

    const first = await cleanup.sweep(NOW);
    const second = await cleanup.sweep(NOW);

    expect(first[0]!.deleted).toBeGreaterThan(0);
    expect(second[0]!.deleted).toBe(0);
  });

  it('never strands a projection whose h0 actual was deleted (pairing invariant)', async () => {
    // The landmine this design exists to make impossible. A synced cluster is
    // used deliberately: its scalar baseline capacity is 0, so `computeUncertainty`
    // has no fallback source of actuals — if the sweep ever broke the pairing,
    // the band would silently shrink with no error anywhere.
    const { id, metricTypeId } = await makeCluster(prisma, {
      source: 'vsphere',
      baselineDate: monthStart(0),
      baselineConsumption: 500,
      baselineCapacity: 0,
    });
    await makeHost(prisma, {
      clusterId: id,
      commissionedAt: monthStart(-36),
      initialCapacity: [{ effectiveFrom: monthStart(-36), amount: 1000 }],
    });
    // Anchors spanning the cutoff in both directions, projecting across it too.
    for (let i = -24; i <= 0; i++) {
      await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i), 0, 0.5);
    }
    for (let i = -24; i <= -1; i++) {
      for (const horizon of [1, 6, 18]) {
        if (i + horizon > 0) continue;
        await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i + horizon), horizon, 0.6);
      }
    }

    await setRetention(12, true);
    await new ForecastSnapshotCleanup(prisma).sweep(NOW);

    const rows = await prisma.forecastSnapshot.findMany({
      where: { clusterId: id },
      select: { horizonMonth: true, horizonIndex: true },
    });
    const actualMonths = new Set(
      rows.filter((r) => r.horizonIndex === 0).map((r) => r.horizonMonth.getTime()),
    );
    const projections = rows.filter((r) => r.horizonIndex > 0);
    expect(projections.length).toBeGreaterThan(0);
    // Every surviving projection still has the h0 row it pairs with.
    for (const p of projections) {
      expect(actualMonths.has(p.horizonMonth.getTime())).toBe(true);
    }
  });

  it('leaves the band unchanged — the sweep only removes what the read already ignored', async () => {
    const { id, metricTypeId } = await makeCluster(prisma, {
      baselineDate: monthStart(0),
      baselineConsumption: 100,
      baselineCapacity: 200,
    });
    for (let i = -30; i <= 0; i++) {
      await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i), 0, 0.5);
    }
    for (let i = -30; i <= -1; i++) {
      await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i + 1), 1, 0.6);
    }
    await setRetention(12, true);

    const service = new ForecastService(prisma);
    const before = await service.forCluster(TENANT, id, METRIC);
    await new ForecastSnapshotCleanup(prisma).sweep(NOW);
    const after = await service.forCluster(TENANT, id, METRIC);

    expect(after.uncertaintyAnchorCount).toBe(before.uncertaintyAnchorCount);
    expect(after.uncertainty).toEqual(before.uncertainty);
  });

  it('logs every tenant it pruned, so a destructive tick is reconstructable', async () => {
    const info = vi.fn();
    await seedThreeYears();
    await setRetention(12);

    await new ForecastSnapshotCleanup(prisma, { info, warn: vi.fn() }).sweep(NOW);

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, retentionMonths: 12, cutoff: '2025-08-01' }),
      'pruned forecast snapshots past retention',
    );
  });

  it('logs a warning and keeps going instead of throwing when a delete fails', async () => {
    const warn = vi.fn();
    await seedThreeYears();
    await setRetention(12);
    vi.spyOn(prisma.forecastSnapshot, 'deleteMany').mockRejectedValueOnce(
      new Error('connection lost'),
    );

    const results = await new ForecastSnapshotCleanup(prisma, { info: vi.fn(), warn }).sweep(NOW);

    expect(results).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(Error), tenantId: TENANT },
      'forecast-snapshot cleanup sweep failed',
    );
  });

  it('joins the run already in flight rather than sweeping twice at once', async () => {
    // A second concurrent sweep would overwrite `activeRun`, and whichever
    // settled first would clear it — leaving `stop()` draining a finished run
    // while a live one kept deleting through shutdown.
    await seedThreeYears();
    await setRetention(12);
    const deleteMany = vi.spyOn(prisma.forecastSnapshot, 'deleteMany');
    const cleanup = new ForecastSnapshotCleanup(prisma);

    const [a, b] = await Promise.all([cleanup.sweep(NOW), cleanup.sweep(NOW)]);

    expect(deleteMany).toHaveBeenCalledTimes(1);
    // Both callers get the same answer, so the join is invisible to them.
    expect(b).toBe(a);
    expect(a[0]!.deleted).toBeGreaterThan(0);
  });
});

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function buildApp(autostart: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin, { prisma });
  await app.register(forecastSnapshotCleanupPlugin, {
    autostart,
    tickIntervalMs: 60 * 60 * 1000,
  });
  apps.push(app);
  return app;
}

describe('forecastSnapshotCleanupPlugin', () => {
  it('does NOT start the tick when autostart is false', async () => {
    const app = await buildApp(false);
    expect(app.forecastSnapshotCleanup.isRunning()).toBe(false);
  });

  it('starts the tick when autostart is true, and stops it on close', async () => {
    const app = await buildApp(true);
    expect(app.forecastSnapshotCleanup.isRunning()).toBe(true);

    await app.close();
    apps.length = 0;
    expect(app.forecastSnapshotCleanup.isRunning()).toBe(false);
  });

  it('buildServer never auto-starts the prune tick in the test environment', async () => {
    const server = await buildServer({ env: makeTestEnv(), prisma });
    apps.push(server);
    expect(server.forecastSnapshotCleanup.isRunning()).toBe(false);
  });
});
