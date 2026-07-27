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
  snapshotRetentionMonths = 0,
): Promise<void> {
  await new SettingsService(prisma).updateTenant(TENANT, {
    warnThreshold: 0.7,
    critThreshold: 0.9,
    procurementLeadTimeWeeks: 8,
    idempotencyKeyRetentionHours: 24,
    forecastUncertaintyBandEnabled: true,
    forecastUncertaintyMinAnchors: minAnchors,
    forecastUncertaintyBandWidth: bandWidth,
    forecastSnapshotRetentionMonths: snapshotRetentionMonths,
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

  describe('per-horizon sample count (#317)', () => {
    it('reports each band point its own horizon evidence, well below the global N', async () => {
      const { id, metricTypeId } = await makeCluster(prisma, {
        baselineDate: monthStart(0),
        baselineConsumption: 100,
        baselineCapacity: 200,
      });
      // Actuals for every month that any projection lands on.
      for (let i = -24; i <= 0; i++) {
        await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i), 0, 0.5);
      }
      // Horizon 1 measured NINE times (anchors −9..−1 → horizon months −8..0).
      for (let i = -9; i <= -1; i++) {
        await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i + 1), 1, 0.6);
      }
      // Horizon 12 measured only THREE times (anchors −15..−13 → months −3..−1).
      for (let i = -15; i <= -13; i++) {
        await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i + 12), 12, 0.6);
      }

      await enableBand(6);
      const result = await new ForecastService(prisma).forCluster(TENANT, id, METRIC);

      // 12 distinct anchors produced a paired error — the number the caption used
      // to quote against EVERY month of the band.
      expect(result.uncertaintyAnchorCount).toBe(12);

      const at = (offset: number): number | undefined =>
        result.uncertainty!.find((p) => p.month === toIso(monthStart(offset)))?.sampleCount;
      expect(at(1)).toBe(9);
      // The far end rests on a quarter of the claimed evidence. This gap is the
      // whole reason the field exists.
      expect(at(12)).toBe(3);

      // Invariant: an anchor contributes at most one sample per horizon index, so
      // no point can claim more evidence than the pool holds.
      for (const p of result.uncertainty!) {
        expect(p.sampleCount).toBeDefined();
        expect(p.sampleCount!).toBeLessThanOrEqual(result.uncertaintyAnchorCount!);
        expect(p.sampleCount!).toBeGreaterThanOrEqual(3); // PER_HORIZON_MIN_SAMPLES
      }
    });

    it('shows the retention window capping evidence while N keeps climbing (#318 × #317)', async () => {
      // The interaction #318 introduced: one retained month yields at most one
      // sample per horizon index, so `retentionMonths` caps every horizon — but an
      // anchor up to 24 months older than the window still projects INTO it, so
      // the anchor count is not capped and keeps growing past it.
      //
      // Scope, so the numbers below are not mistaken for the worst case: this
      // seeds evidence at two horizons (1 and 24), which exercises the MECHANISM
      // and lands N at 15. The general bound is `retentionMonths + (maxHorizon -
      // 1)` — the union of the per-horizon valid-anchor windows across horizons
      // 1..maxHorizon spans that many months — so at the 24-month default with a
      // 12-month window it is 35, and a longer requested span widens it further.
      // Seeding all 24 horizons to reach 35 would grow the fixture without
      // pinning anything these assertions do not already pin.
      const { id, metricTypeId } = await makeCluster(prisma, {
        baselineDate: monthStart(0),
        baselineConsumption: 100,
        baselineCapacity: 200,
      });
      for (let i = -30; i <= 0; i++) {
        await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i), 0, 0.5);
      }
      // Thirty monthly horizon-1 projections; only the twelve landing inside a
      // 12-month window survive the read.
      for (let i = -30; i <= -1; i++) {
        await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i + 1), 1, 0.6);
      }
      // Three ancient anchors (−35..−33) whose 24-month horizons land at −11..−9,
      // i.e. inside the window. They count toward N without adding evidence to
      // any horizon but 24.
      for (let i = -35; i <= -33; i++) {
        await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i + 24), 24, 0.6);
      }

      await enableBand(6, 'p10_p90', 12);
      const result = await new ForecastService(prisma).forCluster(TENANT, id, METRIC);

      const at = (offset: number): number | undefined =>
        result.uncertainty!.find((p) => p.month === toIso(monthStart(offset)))?.sampleCount;
      // Capped by the 12-month window, not by how many anchors exist.
      expect(at(1)).toBe(12);
      expect(at(24)).toBe(3);
      // ...while N exceeds the window, because anchors older than it still project
      // into it. A caption naming only N would claim 15 forecasts behind a band
      // resting on 3.
      expect(result.uncertaintyAnchorCount).toBe(15);
      expect(at(24)!).toBeLessThan(result.uncertaintyAnchorCount!);
    });
  });

  describe('retention window bounds the READ (#318)', () => {
    /**
     * 24 monthly re-anchors, each over-forecasting horizon 1 by a margin that
     * depends on how old the anchor is: months older than a year missed by
     * +0.30, recent ones by only +0.10. A retention window that excludes the
     * old, bad evidence must visibly tighten the band.
     */
    async function seedTwoEras(): Promise<{ id: string }> {
      const { id, metricTypeId } = await makeCluster(prisma, {
        baselineDate: monthStart(0),
        baselineConsumption: 100,
        baselineCapacity: 200,
      });
      for (let i = -24; i <= 0; i++) {
        await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i), 0, 0.5); // actual
      }
      for (let i = -24; i <= -1; i++) {
        const projected = i < -12 ? 0.8 : 0.6; // error +0.30 (old era) vs +0.10 (recent)
        await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i + 1), 1, projected);
      }
      return { id };
    }

    it('keeps every sample when retention is off (the default)', async () => {
      const { id } = await seedTwoEras();
      await enableBand(6, 'p10_p90', 0);
      const result = await new ForecastService(prisma).forCluster(TENANT, id, METRIC);
      // 24 paired anchors, both eras present.
      expect(result.uncertaintyAnchorCount).toBe(24);
    });

    it('excludes evidence older than the window without deleting anything', async () => {
      const { id } = await seedTwoEras();
      const before = await prisma.forecastSnapshot.count({ where: { clusterId: id } });

      await enableBand(6, 'p10_p90', 12);
      const result = await new ForecastService(prisma).forCluster(TENANT, id, METRIC);

      // The read narrowed...
      expect(result.uncertaintyAnchorCount).toBeLessThan(24);
      expect(result.uncertainty).toBeDefined();
      // ...but the rows are all still on disk. This PR windows the READ only.
      expect(await prisma.forecastSnapshot.count({ where: { clusterId: id } })).toBe(before);
    });

    it('tightens the band when the window excludes a worse forecasting era', async () => {
      const { id } = await seedTwoEras();
      const service = new ForecastService(prisma);

      await enableBand(6, 'p10_p90', 0);
      const wide = await service.forCluster(TENANT, id, METRIC);
      await enableBand(6, 'p10_p90', 12);
      const narrow = await service.forCluster(TENANT, id, METRIC);

      const h1 = (r: typeof wide): { low: number; high: number } => {
        const p = r.uncertainty!.find((x) => x.month === toIso(monthStart(1)));
        expect(p).toBeDefined();
        return { low: p!.low, high: p!.high };
      };
      const wideH1 = h1(wide);
      const narrowH1 = h1(narrow);
      // Dropping the +0.30-error era leaves only the consistent +0.10 misses, so
      // the retained band is strictly narrower.
      expect(narrowH1.high - narrowH1.low).toBeLessThan(wideH1.high - wideH1.low);
    });

    it('counts anchors OLDER than the window when they project into it', async () => {
      // The point of keying on horizonMonth rather than anchorMonth: a 20-month-old
      // anchor whose horizon lands inside the window is still valid evidence for
      // that horizon, and the window must not silently discard long horizons.
      const { id, metricTypeId } = await makeCluster(prisma, {
        baselineDate: monthStart(0),
        baselineConsumption: 100,
        baselineCapacity: 200,
      });
      for (let i = -11; i <= 0; i++) {
        await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i), 0, 0.5);
      }
      // Anchors -20..-15 (all far outside a 12-month window) projecting to
      // horizon months -8..-3, which are INSIDE it.
      for (let i = -20; i <= -15; i++) {
        await seedSnapshot(id, metricTypeId, monthStart(i), monthStart(i + 12), 12, 0.6);
      }

      await enableBand(6, 'p10_p90', 12);
      const result = await new ForecastService(prisma).forCluster(TENANT, id, METRIC);

      // All six ancient anchors still count — anchorCount is not capped by the window.
      expect(result.uncertaintyAnchorCount).toBe(6);
    });
  });
});
