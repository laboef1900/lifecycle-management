import { Prisma } from '@prisma/client';
import type { ForecastUncertaintyBandWidth } from '@lcm/shared';
import { describe, expect, it } from 'vitest';

import { makeCluster, makeHost } from './factories.js';
import { prisma } from './setup.js';
import { ForecastService } from '../services/forecast-loader.js';
import { SettingsService } from '../services/settings.js';

const TENANT = 'default';
const METRIC = 'memory_gb';

/** First-of-month UTC, `offset` months from the current month. */
function monthStart(offset: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function enableBand(
  minAnchors = 6,
  bandWidth: ForecastUncertaintyBandWidth = 'p10_p90',
): Promise<void> {
  await new SettingsService(prisma).updateTenant(TENANT, {
    warnThreshold: 0.7,
    critThreshold: 0.9,
    procurementLeadTimeWeeks: 8,
    idempotencyKeyRetentionHours: 24,
    forecastUncertaintyBandEnabled: true,
    forecastUncertaintyMinAnchors: minAnchors,
    forecastUncertaintyBandWidth: bandWidth,
  });
}

/** Insert a raw forecast snapshot row (an anchor's projection for one horizon). */
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

describe('ForecastService — uncertainty band', () => {
  it('snapshotForecast persists the anchor-month actual (h0) plus future projections', async () => {
    const anchor = monthStart(0);
    const { id } = await makeCluster(prisma, {
      baselineDate: anchor,
      baselineConsumption: 100,
      baselineCapacity: 200,
    });
    await new ForecastService(prisma).snapshotForecast(TENANT, id, METRIC);

    const rows = await prisma.forecastSnapshot.findMany({ where: { clusterId: id } });
    expect(rows.length).toBeGreaterThan(0);
    // The anchor-month row (h0) is the measured actual; the rest are future (>= 1).
    const h0 = rows.filter((r) => r.horizonIndex === 0);
    expect(h0).toHaveLength(1);
    expect(h0[0]!.horizonMonth.getTime()).toBe(anchor.getTime());
    expect(rows.some((r) => r.horizonIndex >= 1)).toBe(true);
    expect(rows.every((r) => r.horizonIndex >= 0)).toBe(true);
    expect(rows.every((r) => r.anchorMonth.getTime() === anchor.getTime())).toBe(true);

    // Idempotent: a second snapshot of the same anchor adds nothing.
    await new ForecastService(prisma).snapshotForecast(TENANT, id, METRIC);
    const again = await prisma.forecastSnapshot.count({ where: { clusterId: id } });
    expect(again).toBe(rows.length);
  });

  it('captures a capacity-correct h0 actual for a SYNCED cluster (scalar capacity is 0)', async () => {
    // Regression guard (review Finding 1). A vSphere-synced baseline writes
    // baselineCapacity = 0 (the hosts ARE the capacity), so deriving the band's
    // "actual" from ClusterBaselineHistory utilization would be null and the band
    // could NEVER appear for synced clusters. The h0 actual instead comes from
    // computeForecast's month-0, which folds host capacity.
    const anchor = monthStart(0);
    const { id, metricTypeId } = await makeCluster(prisma, {
      source: 'vsphere',
      baselineDate: anchor,
      baselineConsumption: 500,
      baselineCapacity: 0,
    });
    await makeHost(prisma, {
      clusterId: id,
      commissionedAt: monthStart(-12),
      initialCapacity: [{ effectiveFrom: monthStart(-12), amount: 1000 }],
    });

    await new ForecastService(prisma).snapshotForecast(TENANT, id, METRIC);

    const h0 = await prisma.forecastSnapshot.findFirstOrThrow({
      where: { clusterId: id, metricTypeId, horizonIndex: 0 },
    });
    // 500 / 1000 host capacity — a real utilization, NOT null. Proves the actual
    // folds host capacity rather than dividing by the zero scalar.
    expect(h0.projectedUtil.toNumber()).toBeCloseTo(0.5, 5);
  });

  it('omits the band when disabled (default), and never on a scenario (INV-1)', async () => {
    const { id } = await makeCluster(prisma, {
      baselineDate: monthStart(0),
      baselineConsumption: 100,
      baselineCapacity: 200,
    });
    const svc = new ForecastService(prisma);

    // Disabled by default.
    const off = await svc.forCluster(TENANT, id, METRIC);
    expect(off.uncertainty).toBeUndefined();

    // Even enabled, a scenario NEVER carries a band (INV-1).
    await enableBand();
    const scenario = await svc.forClusterWithScenario(TENANT, id, METRIC, {
      kind: 'lose_hosts',
      count: 1,
    });
    expect(scenario.uncertainty).toBeUndefined();
  });

  it('omits the band below the anchor floor even when enabled', async () => {
    const { id, metricTypeId } = await makeCluster(prisma, {
      baselineDate: monthStart(0),
      baselineConsumption: 100,
      baselineCapacity: 200,
    });
    // Two matured re-anchors, each with its h0 actual and a horizon-1 projection.
    for (const o of [-2, -1]) {
      await seedSnapshot(id, metricTypeId, monthStart(o), monthStart(o), 0, 0.5); // actual
      await seedSnapshot(id, metricTypeId, monthStart(o), monthStart(o + 1), 1, 0.6); // projection
    }
    await seedSnapshot(id, metricTypeId, monthStart(0), monthStart(0), 0, 0.5); // actual for -1's horizon
    // 2 sampled anchors < K=6.
    await enableBand(6);
    const result = await new ForecastService(prisma).forCluster(TENANT, id, METRIC);
    expect(result.uncertainty).toBeUndefined();
  });

  it('attaches a band for a SYNCED cluster once enough re-anchors + measured actuals exist', async () => {
    // The end-to-end Finding-1 case: a synced cluster whose baseline scalar
    // capacity is 0 (baselineHistory utilization is therefore null) still gets a
    // band, because the actuals come from the h0 snapshots — not baselineHistory.
    const anchor = monthStart(0);
    const { id, metricTypeId } = await makeCluster(prisma, {
      source: 'vsphere',
      baselineDate: anchor,
      baselineConsumption: 500,
      baselineCapacity: 0,
    });
    await makeHost(prisma, {
      clusterId: id,
      commissionedAt: monthStart(-12),
      initialCapacity: [{ effectiveFrom: monthStart(-12), amount: 1000 }],
    });

    // Six past re-anchors (−6..−1): each projected horizon-1 utilization 0.6, and
    // the actual at each horizon month (captured as that month's h0) came in at
    // 0.5 — a consistent +0.1 over-forecast, all matured.
    for (let i = -6; i <= 0; i++) {
      await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i), 0, 0.5); // h0 actual
    }
    for (let i = -6; i <= -1; i++) {
      await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i + 1), 1, 0.6); // projection
    }

    await enableBand(6);
    const result = await new ForecastService(prisma).forCluster(TENANT, id, METRIC);

    // The synced cluster's own baseline utilization is null — the band did NOT
    // come from there.
    expect(result.baselineHistory.every((b) => b.utilization === null)).toBe(true);

    expect(result.uncertainty).toBeDefined();
    expect(result.uncertainty!.length).toBeGreaterThan(0);
    expect(result.uncertaintyAnchorCount).toBe(6);
    for (const p of result.uncertainty!) {
      expect(p.low).toBeLessThanOrEqual(p.high);
      expect(typeof p.month).toBe('string');
    }
    // The horizon-1 band reflects the +0.1 over-forecast → centred BELOW the ~0.5
    // projection (bias-inclusive), so the upper bound is under the line.
    const h1 = result.uncertainty!.find((p) => p.month === toIso(monthStart(1)));
    expect(h1).toBeDefined();
    expect(h1!.high).toBeLessThan(0.5);
  });

  it('does not count matured re-anchors that produced no measured actual (honest N)', async () => {
    // Review Finding 2 / F2: a matured anchor whose horizon month was never
    // measured (a data gap — no h0 for that month) contributes no sample and must
    // not inflate the floor or the caption's "N". Here 6 anchors project, but only
    // 3 horizon months were ever measured → below the 4-anchor floor → no band.
    const { id, metricTypeId } = await makeCluster(prisma, {
      baselineDate: monthStart(0),
      baselineConsumption: 100,
      baselineCapacity: 200,
    });
    // Six projections at horizon 1 (anchors −6..−1 → horizon months −5..0).
    for (let i = -6; i <= -1; i++) {
      await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i + 1), 1, 0.6);
    }
    // But only THREE of those horizon months were actually measured (h0 rows).
    for (const m of [-5, -4, -3]) {
      await seedSnapshot(id, metricTypeId, monthStart(m), monthStart(m), 0, 0.5);
    }
    await enableBand(4); // floor of 4; only 3 anchors truly paired
    const result = await new ForecastService(prisma).forCluster(TENANT, id, METRIC);
    expect(result.uncertainty).toBeUndefined();
  });
});
