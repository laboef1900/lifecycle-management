import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});

afterAll(async () => {
  await server.close();
});

let sequence = 0;
const uniqueName = (suffix: string): string => {
  sequence += 1;
  return `settings-${suffix}-${sequence}`;
};

async function createCluster(name: string): Promise<string> {
  const res = await server.inject({
    method: 'POST',
    url: '/api/clusters',
    payload: {
      name,
      baselineDate: '2026-05-01',
      baselines: [{ metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 }],
    },
  });
  const body = res.json() as { id: string };
  return body.id;
}

describe('GET /api/settings/tenant', () => {
  it('returns defaults on first read', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/settings/tenant' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      warnThreshold: number;
      critThreshold: number;
      procurementLeadTimeWeeks: number;
      idempotencyKeyRetentionHours: number;
    };
    expect(body.warnThreshold).toBeCloseTo(0.7);
    expect(body.critThreshold).toBeCloseTo(0.9);
    expect(body.procurementLeadTimeWeeks).toBe(8);
    expect(body.idempotencyKeyRetentionHours).toBe(24);
  });
});

describe('PUT /api/settings/tenant', () => {
  it('updates tenant settings', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings/tenant',
      payload: {
        warnThreshold: 0.65,
        critThreshold: 0.85,
        procurementLeadTimeWeeks: 10,
        idempotencyKeyRetentionHours: 24,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { warnThreshold: number; procurementLeadTimeWeeks: number };
    expect(body.warnThreshold).toBeCloseTo(0.65);
    expect(body.procurementLeadTimeWeeks).toBe(10);
  });

  it('rejects warn >= crit', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings/tenant',
      payload: {
        warnThreshold: 0.9,
        critThreshold: 0.7,
        procurementLeadTimeWeeks: 8,
        idempotencyKeyRetentionHours: 24,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts procurementLeadTimeWeeks at the 0 boundary (disables lead-time KPI)', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings/tenant',
      payload: {
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: 0,
        idempotencyKeyRetentionHours: 24,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts procurementLeadTimeWeeks at the 104 boundary (two years)', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings/tenant',
      payload: {
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: 104,
        idempotencyKeyRetentionHours: 24,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects procurementLeadTimeWeeks above 104', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings/tenant',
      payload: {
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: 105,
        idempotencyKeyRetentionHours: 24,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects negative procurementLeadTimeWeeks', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings/tenant',
      payload: {
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: -1,
        idempotencyKeyRetentionHours: 24,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-integer procurementLeadTimeWeeks', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings/tenant',
      payload: {
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: 4.5,
        idempotencyKeyRetentionHours: 24,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts idempotencyKeyRetentionHours at the 1 and 168 boundaries', async () => {
    const low = await server.inject({
      method: 'PUT',
      url: '/api/settings/tenant',
      payload: {
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: 8,
        idempotencyKeyRetentionHours: 1,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      },
    });
    expect(low.statusCode).toBe(200);
    expect(
      (low.json() as { idempotencyKeyRetentionHours: number }).idempotencyKeyRetentionHours,
    ).toBe(1);

    const high = await server.inject({
      method: 'PUT',
      url: '/api/settings/tenant',
      payload: {
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: 8,
        idempotencyKeyRetentionHours: 168,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      },
    });
    expect(high.statusCode).toBe(200);
    expect(
      (high.json() as { idempotencyKeyRetentionHours: number }).idempotencyKeyRetentionHours,
    ).toBe(168);
  });

  it('rejects idempotencyKeyRetentionHours outside 1..168', async () => {
    const tooLow = await server.inject({
      method: 'PUT',
      url: '/api/settings/tenant',
      payload: {
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: 8,
        idempotencyKeyRetentionHours: 0,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      },
    });
    expect(tooLow.statusCode).toBe(400);

    const tooHigh = await server.inject({
      method: 'PUT',
      url: '/api/settings/tenant',
      payload: {
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: 8,
        idempotencyKeyRetentionHours: 169,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      },
    });
    expect(tooHigh.statusCode).toBe(400);
  });
});

describe('GET /api/clusters/:id/settings', () => {
  it('returns nulls + tenant-source effective when no override', async () => {
    const id = await createCluster(uniqueName('get-empty'));
    const res = await server.inject({ method: 'GET', url: `/api/clusters/${id}/settings` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      warnThreshold: number | null;
      critThreshold: number | null;
      effective: { warn: number; crit: number; source: string };
    };
    expect(body.warnThreshold).toBeNull();
    expect(body.effective.source).toBe('tenant');
  });

  it('returns 404 for unknown cluster', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/clusters/clbogusclubogusclubogus0/settings',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /api/clusters/:id/settings', () => {
  it('saves overrides', async () => {
    const id = await createCluster(uniqueName('put-ok'));
    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${id}/settings`,
      payload: { warnThreshold: 0.6, critThreshold: 0.85 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { effective: { source: string } };
    expect(body.effective.source).toBe('cluster');
  });

  it('rejects effective warn >= crit with 422', async () => {
    const id = await createCluster(uniqueName('put-bad'));
    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${id}/settings`,
      payload: { warnThreshold: 0.95, critThreshold: null },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('DELETE /api/clusters/:id/settings', () => {
  it('removes the override and returns inherited effective', async () => {
    const id = await createCluster(uniqueName('del'));
    await server.inject({
      method: 'PUT',
      url: `/api/clusters/${id}/settings`,
      payload: { warnThreshold: 0.6, critThreshold: 0.85 },
    });
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/clusters/${id}/settings`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      warnThreshold: number | null;
      effective: { source: string };
    };
    expect(body.warnThreshold).toBeNull();
    expect(body.effective.source).toBe('tenant');
  });
});
