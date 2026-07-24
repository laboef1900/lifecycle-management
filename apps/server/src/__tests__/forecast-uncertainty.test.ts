import { Prisma } from '@prisma/client';
import type { ForecastUncertaintyBandWidth } from '@lcm/shared';
import { describe, expect, it } from 'vitest';

import { makeCluster } from './factories.js';
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

describe('ForecastService — uncertainty band', () => {
  it('snapshotForecast persists future-month projections keyed on the re-anchor', async () => {
    const anchor = monthStart(0);
    const { id } = await makeCluster(prisma, {
      baselineDate: anchor,
      baselineConsumption: 100,
      baselineCapacity: 200,
    });
    await new ForecastService(prisma).snapshotForecast(TENANT, id, METRIC);

    const rows = await prisma.forecastSnapshot.findMany({ where: { clusterId: id } });
    expect(rows.length).toBeGreaterThan(0);
    // Only future horizons (>= 1), all keyed on the anchor month.
    expect(rows.every((r) => r.horizonIndex >= 1)).toBe(true);
    expect(rows.every((r) => r.anchorMonth.getTime() === anchor.getTime())).toBe(true);
    // Idempotent: a second snapshot of the same anchor adds nothing.
    await new ForecastService(prisma).snapshotForecast(TENANT, id, METRIC);
    const again = await prisma.forecastSnapshot.count({ where: { clusterId: id } });
    expect(again).toBe(rows.length);
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
      extraBaselines: [-1, -2].map((o) => ({
        metricKey: METRIC,
        capturedAt: monthStart(o),
        baselineConsumption: 100,
        baselineCapacity: 200,
      })),
    });
    // Only 2 matured anchors < K=6.
    for (const o of [-1, -2]) {
      await prisma.forecastSnapshot.create({
        data: {
          clusterId: id,
          metricTypeId,
          tenantId: TENANT,
          anchorMonth: monthStart(o - 1),
          horizonMonth: monthStart(o),
          horizonIndex: 1,
          projectedUtil: new Prisma.Decimal(0.6),
        },
      });
    }
    await enableBand(6);
    const result = await new ForecastService(prisma).forCluster(TENANT, id, METRIC);
    expect(result.uncertainty).toBeUndefined();
  });

  it('attaches a band once enough matured anchors + actuals exist', async () => {
    // Seven months of measured actuals (util 0.5), newest = current month (anchor).
    const extraBaselines = [-6, -5, -4, -3, -2, -1].map((o) => ({
      metricKey: METRIC,
      capturedAt: monthStart(o),
      baselineConsumption: 100,
      baselineCapacity: 200,
    }));
    const { id, metricTypeId } = await makeCluster(prisma, {
      baselineDate: monthStart(0),
      baselineConsumption: 100,
      baselineCapacity: 200,
      extraBaselines,
    });

    // Six past horizon-1 forecasts (anchors −6..−1) that projected 0.6 while the
    // actual came in at 0.5 → a consistent +0.1 over-forecast, all matured.
    for (let i = -6; i <= -1; i++) {
      await prisma.forecastSnapshot.create({
        data: {
          clusterId: id,
          metricTypeId,
          tenantId: TENANT,
          anchorMonth: monthStart(i),
          horizonMonth: monthStart(i + 1),
          horizonIndex: 1,
          projectedUtil: new Prisma.Decimal(0.6),
        },
      });
    }

    await enableBand(6);
    const result = await new ForecastService(prisma).forCluster(TENANT, id, METRIC);

    expect(result.uncertainty).toBeDefined();
    expect(result.uncertainty!.length).toBeGreaterThan(0);
    for (const p of result.uncertainty!) {
      expect(p.low).toBeLessThanOrEqual(p.high);
      expect(typeof p.month).toBe('string');
    }
    // The horizon-1 band reflects the +0.1 over-forecast → centred BELOW the
    // projection (bias-inclusive), i.e. the upper bound is at most the line.
    const h1 = result.uncertainty!.find((p) => p.month === toIso(monthStart(1)));
    expect(h1).toBeDefined();
    expect(h1!.high).toBeLessThan(0.5);
  });
});

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
