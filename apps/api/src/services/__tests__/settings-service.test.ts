import { describe, expect, it } from 'vitest';

import { prisma } from '../../__tests__/setup.js';
import { SettingsService } from '../settings.js';

const TENANT_ID = 'default';

async function makeCluster(name: string): Promise<string> {
  const cluster = await prisma.cluster.create({
    data: {
      tenantId: TENANT_ID,
      name,
      baselineDate: new Date('2026-05-01'),
    },
  });
  return cluster.id;
}

describe('SettingsService.getTenant', () => {
  it('auto-creates a default row on first read', async () => {
    const svc = new SettingsService(prisma);
    const result = await svc.getTenant(TENANT_ID);
    expect(result.warnThreshold).toBeCloseTo(0.7);
    expect(result.critThreshold).toBeCloseTo(0.9);
  });

  it('is idempotent', async () => {
    const svc = new SettingsService(prisma);
    await svc.getTenant(TENANT_ID);
    const result = await svc.getTenant(TENANT_ID);
    expect(result.warnThreshold).toBeCloseTo(0.7);
  });
});

describe('SettingsService.updateTenant', () => {
  it('persists new values', async () => {
    const svc = new SettingsService(prisma);
    const result = await svc.updateTenant(TENANT_ID, {
      warnThreshold: 0.65,
      critThreshold: 0.85,
      procurementLeadTimeWeeks: 6,
    });
    expect(result.warnThreshold).toBeCloseTo(0.65);
    expect(result.critThreshold).toBeCloseTo(0.85);
    expect(result.procurementLeadTimeWeeks).toBe(6);
  });

  it('persists procurementLeadTimeWeeks separately from thresholds', async () => {
    const svc = new SettingsService(prisma);
    await svc.updateTenant(TENANT_ID, {
      warnThreshold: 0.7,
      critThreshold: 0.9,
      procurementLeadTimeWeeks: 12,
    });
    const result = await svc.getTenant(TENANT_ID);
    expect(result.procurementLeadTimeWeeks).toBe(12);
  });
});

describe('SettingsService.getCluster', () => {
  it('returns nulls + tenant-inherited effective when no override exists', async () => {
    const svc = new SettingsService(prisma);
    const clusterId = await makeCluster('no-override');
    const result = await svc.getCluster(TENANT_ID, clusterId);
    expect(result.warnThreshold).toBeNull();
    expect(result.critThreshold).toBeNull();
    expect(result.effective.warn).toBeCloseTo(0.7);
    expect(result.effective.crit).toBeCloseTo(0.9);
    expect(result.effective.source).toBe('tenant');
  });
});

describe('SettingsService.updateCluster', () => {
  it('persists overrides and returns cluster-source effective', async () => {
    const svc = new SettingsService(prisma);
    const clusterId = await makeCluster('override-both');
    const result = await svc.updateCluster(TENANT_ID, clusterId, {
      warnThreshold: 0.6,
      critThreshold: 0.85,
    });
    expect(result.warnThreshold).toBeCloseTo(0.6);
    expect(result.critThreshold).toBeCloseTo(0.85);
    expect(result.effective.warn).toBeCloseTo(0.6);
    expect(result.effective.source).toBe('cluster');
  });

  it('rejects when effective warn >= crit (partial override + tenant default)', async () => {
    const svc = new SettingsService(prisma);
    const clusterId = await makeCluster('bad-override');
    await svc.updateTenant(TENANT_ID, {
      warnThreshold: 0.7,
      critThreshold: 0.9,
      procurementLeadTimeWeeks: 8,
    });
    await expect(
      svc.updateCluster(TENANT_ID, clusterId, {
        warnThreshold: 0.95,
        critThreshold: null,
      }),
    ).rejects.toThrow(/effective/i);
  });
});

describe('SettingsService.resetCluster', () => {
  it('deletes the row and returns inherited effective', async () => {
    const svc = new SettingsService(prisma);
    const clusterId = await makeCluster('reset-me');
    await svc.updateCluster(TENANT_ID, clusterId, {
      warnThreshold: 0.6,
      critThreshold: 0.8,
    });
    const result = await svc.resetCluster(TENANT_ID, clusterId);
    expect(result.warnThreshold).toBeNull();
    expect(result.critThreshold).toBeNull();
    expect(result.effective.source).toBe('tenant');
  });

  it('is idempotent when no row exists', async () => {
    const svc = new SettingsService(prisma);
    const clusterId = await makeCluster('reset-noop');
    const result = await svc.resetCluster(TENANT_ID, clusterId);
    expect(result.warnThreshold).toBeNull();
  });
});
