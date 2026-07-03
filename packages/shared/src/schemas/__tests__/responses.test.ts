import { describe, expect, it } from 'vitest';

import type {
  ClusterResponse,
  ForecastResponse,
  HostResponse,
  ItemResponse,
  TenantSettings,
} from '../../index.js';
import {
  clusterResponseSchema,
  forecastResponseSchema,
  hostResponseSchema,
  itemResponseSchema,
  tenantSettingsResponseSchema,
} from '../responses.js';

describe('clusterResponseSchema', () => {
  const literal: ClusterResponse = {
    id: 'cl_1',
    name: 'prod-east',
    description: null,
    baselineDate: '2026-01-01',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    metrics: [
      {
        metricTypeKey: 'memory_gb',
        metricTypeDisplayName: 'Memory (GB)',
        unit: 'GB',
        baselineConsumption: 100,
        baselineCapacity: 200,
        currentConsumption: 120,
        currentCapacity: 200,
        utilization: 0.6,
      },
    ],
  };

  it('round-trips a representative cluster response', () => {
    expect(clusterResponseSchema.safeParse(literal).success).toBe(true);
  });

  it('rejects a non-numeric utilization', () => {
    const bad = {
      ...literal,
      metrics: [{ ...literal.metrics[0], utilization: 'high' }],
    };
    expect(clusterResponseSchema.safeParse(bad).success).toBe(false);
  });
});

describe('hostResponseSchema', () => {
  const literal: HostResponse = {
    id: 'host_1',
    clusterId: 'cl_1',
    name: 'esx-01',
    description: null,
    commissionedAt: '2026-01-01',
    decommissionedAt: null,
    serialNumber: 'SN-123',
    vendor: 'Dell',
    model: 'R740',
    purchasedAt: '2025-12-01',
    warrantyEndsAt: '2028-12-01',
    eolAt: '2030-12-01',
    runPastEol: false,
    state: 'in_service',
    projectedDecommissionAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    capacities: [
      {
        id: 'cap_1',
        metricTypeKey: 'memory_gb',
        metricTypeDisplayName: 'Memory (GB)',
        unit: 'GB',
        effectiveFrom: '2026-01-01',
        amount: 512,
      },
    ],
  };

  it('round-trips a representative host response', () => {
    expect(hostResponseSchema.safeParse(literal).success).toBe(true);
  });

  it('rejects an unknown host state', () => {
    const bad = { ...literal, state: 'melted' };
    expect(hostResponseSchema.safeParse(bad).success).toBe(false);
  });
});

describe('itemResponseSchema', () => {
  const literal: ItemResponse = {
    id: 'item_1',
    clusterId: 'cl_1',
    kind: 'application',
    name: 'ocp-lab',
    category: 'OpenShift',
    description: null,
    effectiveDate: '2026-01-01',
    endedAt: null,
    metricTypeKey: null,
    consumptionDelta: null,
    capacityDelta: null,
    allocations: [
      {
        id: 'alloc_1',
        metricTypeKey: 'memory_gb',
        metricTypeDisplayName: 'Memory (GB)',
        unit: 'GB',
        effectiveFrom: '2026-01-01',
        amount: 64,
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('round-trips a representative item response', () => {
    expect(itemResponseSchema.safeParse(literal).success).toBe(true);
  });

  it('rejects an unknown item kind', () => {
    const bad = { ...literal, kind: 'widget' };
    expect(itemResponseSchema.safeParse(bad).success).toBe(false);
  });
});

describe('forecastResponseSchema', () => {
  const literal: ForecastResponse = {
    fromMonth: '2026-01',
    toMonth: '2026-03',
    months: [{ month: '2026-01', consumption: 100, capacity: 200, utilization: 0.5 }],
    events: [
      {
        id: 'evt_1',
        effectiveDate: '2026-01-15',
        category: 'Migration',
        title: 'Move workload',
        description: null,
        consumptionDelta: 10,
        capacityDelta: null,
      },
    ],
    hosts: [
      {
        id: 'host_1',
        name: 'esx-01',
        projectedDecommissionAt: null,
        contributions: [{ month: '2026-01', amount: 200 }],
      },
    ],
    applications: [
      {
        id: 'item_1',
        name: 'ocp-lab',
        contributions: [{ month: '2026-01', amount: 100 }],
      },
    ],
    effectiveThresholds: { warn: 0.7, crit: 0.9, source: 'tenant' },
    procurement: { leadTimeWeeks: 6, orderByDate: null, breachMonth: null },
  };

  it('round-trips a representative forecast response', () => {
    expect(forecastResponseSchema.safeParse(literal).success).toBe(true);
  });

  it('rejects a malformed effectiveThresholds.source', () => {
    const bad = {
      ...literal,
      effectiveThresholds: { ...literal.effectiveThresholds, source: 'unknown' },
    };
    expect(forecastResponseSchema.safeParse(bad).success).toBe(false);
  });
});

describe('tenantSettingsResponseSchema', () => {
  const literal: TenantSettings = {
    warnThreshold: 0.7,
    critThreshold: 0.9,
    procurementLeadTimeWeeks: 6,
  };

  it('round-trips a representative tenant settings response', () => {
    expect(tenantSettingsResponseSchema.safeParse(literal).success).toBe(true);
  });

  it('tolerates additive unknown server fields (forward compatibility)', () => {
    const withExtra = { ...literal, someFutureField: 'new' };
    expect(tenantSettingsResponseSchema.safeParse(withExtra).success).toBe(true);
  });

  it('rejects a non-numeric warnThreshold', () => {
    const bad = { ...literal, warnThreshold: 'high' };
    expect(tenantSettingsResponseSchema.safeParse(bad).success).toBe(false);
  });
});
