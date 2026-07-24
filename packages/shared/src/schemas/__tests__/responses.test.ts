import { describe, expect, it } from 'vitest';

import type {
  ClusterResponse,
  ForecastResponse,
  HostResponse,
  ItemResponse,
  TenantSettings,
  VsphereConnectionResponse,
  VsphereProbeResult,
} from '../../index.js';
import {
  clusterResponseSchema,
  forecastResponseSchema,
  hostResponseSchema,
  itemResponseSchema,
  tenantSettingsResponseSchema,
  vsphereConnectionResponseSchema,
  vsphereProbeResultSchema,
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

  it('accepts a null utilization for a zero-capacity metric (unknowable, never 0%)', () => {
    const unknown = {
      ...literal,
      metrics: [{ ...literal.metrics[0], currentCapacity: 0, utilization: null }],
    };
    expect(clusterResponseSchema.safeParse(unknown).success).toBe(true);
  });

  it('rejects a non-numeric utilization', () => {
    const bad = {
      ...literal,
      metrics: [{ ...literal.metrics[0], utilization: 'high' }],
    };
    expect(clusterResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a response from a server build that predates sync metadata', () => {
    // `literal` above carries no sync fields at all. This is the neutrality
    // guarantee that lets this contract merge ahead of every producer: an old
    // server's payload keeps parsing, so nothing has to ship in lockstep.
    expect(clusterResponseSchema.safeParse(literal).success).toBe(true);
  });

  it('carries a synced cluster across the boundary WITHOUT stripping the fields', () => {
    // Asserting on the parsed data, not on `.success`. `.success` alone is worth
    // nothing here: z.object strips unknown keys, so an undeclared `source`
    // parses "successfully" and arrives deleted. Stripping IS the bug.
    const synced: ClusterResponse = {
      ...literal,
      source: 'vsphere',
      lastSyncedAt: '2026-07-17T09:00:00.000Z',
      externalName: 'Production',
      connection: { id: 'vc_1', name: 'vc-prod', status: 'active', enabled: true },
      provisionalHostCount: 3,
    };
    const parsed = clusterResponseSchema.parse(synced);
    expect(parsed.source).toBe('vsphere');
    expect(parsed.lastSyncedAt).toBe('2026-07-17T09:00:00.000Z');
    expect(parsed.externalName).toBe('Production');
    expect(parsed.connection).toEqual({
      id: 'vc_1',
      name: 'vc-prod',
      status: 'active',
      enabled: true,
    });
    expect(parsed.provisionalHostCount).toBe(3);
  });

  it('rejects a negative provisionalHostCount', () => {
    const bad = { ...literal, provisionalHostCount: -1 };
    expect(clusterResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('distinguishes "never synced" (null) from "server does not know about sync" (absent)', () => {
    // Two different facts that must not collapse into one. Absent = this build
    // predates sync metadata. null = it does not, and this cluster has simply
    // never synced. #193's UI cannot tell an old deployment from a manual
    // cluster if these merge.
    const neverSynced: ClusterResponse = {
      ...literal,
      source: 'manual',
      lastSyncedAt: null,
      connection: null,
    };
    const parsed = clusterResponseSchema.parse(neverSynced);
    expect(parsed.lastSyncedAt).toBeNull();
    expect(parsed.connection).toBeNull();

    const old = clusterResponseSchema.parse(literal);
    expect('lastSyncedAt' in old).toBe(false);
    expect('source' in old).toBe(false);
  });

  it('rejects a source outside the vocabulary', () => {
    const bad = { ...literal, source: 'vcenter' };
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

  it('accepts a response from a server build that predates sync metadata', () => {
    expect(hostResponseSchema.safeParse(literal).success).toBe(true);
  });

  it('carries a synced host across the boundary WITHOUT stripping the fields', () => {
    const synced: HostResponse = {
      ...literal,
      source: 'vsphere',
      lastSyncedAt: '2026-07-17T09:00:00.000Z',
      // vCenter cannot tell us when a host was commissioned, so sync imports a
      // provisional date and flags it (Q9c). The flag is what lets the UI ask an
      // admin to confirm instead of silently treating a guess as fact.
      commissionedAtProvisional: true,
    };
    const parsed = hostResponseSchema.parse(synced);
    expect(parsed.source).toBe('vsphere');
    expect(parsed.lastSyncedAt).toBe('2026-07-17T09:00:00.000Z');
    expect(parsed.commissionedAtProvisional).toBe(true);
  });

  it('rejects a non-boolean commissionedAtProvisional', () => {
    const bad = { ...literal, commissionedAtProvisional: 'yes' };
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
    months: [
      { month: '2026-01', consumption: 100, capacity: 200, utilization: 0.5 },
      // A zero-capacity month: utilization is null, never 0 — "unknowable", not
      // "healthy". The DTO boundary must carry that distinction to the client.
      { month: '2026-02', consumption: 100, capacity: 0, utilization: null },
    ],
    baselineHistory: [
      {
        capturedAt: '2026-01-01',
        source: 'manual',
        consumption: 100,
        capacity: 200,
        utilization: 0.5,
      },
      {
        capturedAt: '2026-02-01',
        source: 'vsphere',
        consumption: 120,
        capacity: 200,
        utilization: 0.6,
      },
    ],
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

describe('vsphereConnectionResponseSchema', () => {
  const literal: VsphereConnectionResponse = {
    id: 'vc_1',
    name: 'vc-prod',
    hostname: 'vcenter.corp.local',
    port: 443,
    username: 'svc-lcm',
    tlsMode: 'pinned',
    pinnedLeafFingerprintSha256: Array.from({ length: 32 }, () => 'AB').join(':'),
    instanceUuid: '4c4c4544-0000-0000-0000-000000000000',
    apiVersion: '8.0.2.0',
    enabled: true,
    status: 'active',
    lastError: null,
    lastConnectedAt: '2026-07-17T09:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-07-17T09:00:00.000Z',
  };

  it('round-trips a representative connection response', () => {
    expect(vsphereConnectionResponseSchema.safeParse(literal).success).toBe(true);
  });

  it('strips a password that reaches the serialization boundary', () => {
    // The standing guarantee in this schema's @ai-warning ("there is no
    // `password` field and there must never be one"), asserted rather than
    // asserted-by-docstring. If someone adds one, this fails.
    const leaked = { ...literal, password: 'correct horse battery staple' };
    const parsed = vsphereConnectionResponseSchema.parse(leaked);
    expect('password' in parsed).toBe(false);
  });

  it('accepts a connection from a server build that predates syncState', () => {
    const parsed = vsphereConnectionResponseSchema.parse(literal);
    expect('syncState' in parsed).toBe(false);
  });

  it('carries syncState across the boundary WITHOUT stripping it', () => {
    const withState: VsphereConnectionResponse = {
      ...literal,
      syncState: {
        lastSyncAt: '2026-07-17T09:00:00.000Z',
        lastSyncStatus: 'ok',
        lastSnapshotAt: '2026-07-01T00:00:00.000Z',
        lastSnapshotStatus: 'ok',
        lastSuccessPeriod: '2026-07-01',
        failureCount: 0,
      },
    };
    const parsed = vsphereConnectionResponseSchema.parse(withState);
    expect(parsed.syncState?.lastSyncStatus).toBe('ok');
    expect(parsed.syncState?.failureCount).toBe(0);
  });

  it('distinguishes "no job row yet" (null) from "server does not know about jobs" (absent)', () => {
    // The job row is a separate row that may not exist (PK=FK). One null says
    // that in one place; six independent nulls could not tell "no job row" from
    // "job row that has never run".
    const parsed = vsphereConnectionResponseSchema.parse({ ...literal, syncState: null });
    expect(parsed.syncState).toBeNull();
  });

  it('rejects a lastSyncStatus outside the sync outcome vocabulary', () => {
    const bad = {
      ...literal,
      syncState: {
        lastSyncAt: '2026-07-17T09:00:00.000Z',
        lastSyncStatus: 'exploded',
        lastSnapshotAt: null,
        lastSnapshotStatus: null,
        lastSuccessPeriod: null,
        failureCount: 0,
      },
    };
    expect(vsphereConnectionResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("preserves 'skipped' as a sync status — it must survive to be rendered as not-a-failure", () => {
    const skipped = {
      ...literal,
      status: 'identity_mismatch' as const,
      syncState: {
        lastSyncAt: '2026-07-17T09:00:00.000Z',
        lastSyncStatus: 'skipped' as const,
        lastSnapshotAt: null,
        lastSnapshotStatus: null,
        lastSuccessPeriod: null,
        failureCount: 0,
      },
    };
    expect(vsphereConnectionResponseSchema.parse(skipped).syncState?.lastSyncStatus).toBe(
      'skipped',
    );
  });
});

describe('tenantSettingsResponseSchema', () => {
  const literal: TenantSettings = {
    warnThreshold: 0.7,
    critThreshold: 0.9,
    procurementLeadTimeWeeks: 6,
    idempotencyKeyRetentionHours: 24,
    forecastUncertaintyBandEnabled: false,
    forecastUncertaintyMinAnchors: 6,
    forecastUncertaintyBandWidth: 'p10_p90',
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

describe('vsphereProbeResultSchema', () => {
  const base = {
    reachable: false,
    trustedBySystemRoots: false,
    leafFingerprintSha256: null,
    validFrom: null,
    validTo: null,
  };

  // @ai-warning This RUNTIME validator is the web client's boundary — `request()`
  // rejects any response it does not accept with `RESPONSE_VALIDATION`. Its
  // `outcome` enum MUST stay in lockstep with the `VsphereProbeResult.outcome`
  // union in `vsphere.ts`; the `z.ZodType<VsphereProbeResult>` annotation does NOT
  // enforce exhaustiveness (a narrower enum is still assignable), so only a test
  // catches drift.
  it.each(['ok', 'unreachable', 'tls_untrusted', 'not_a_vcenter'] as const)(
    'accepts every VsphereProbeResult outcome the server can send: %s',
    (outcome) => {
      const value: VsphereProbeResult = { ...base, outcome };
      expect(vsphereProbeResultSchema.safeParse(value).success).toBe(true);
    },
  );

  it('rejects an unknown outcome', () => {
    // Also guards the retired #272 chain-incomplete outcome: any value outside the
    // enum (a stale server sending one) is refused, so the web client never receives
    // an outcome it has no branch for.
    expect(vsphereProbeResultSchema.safeParse({ ...base, outcome: 'bogus' }).success).toBe(false);
  });
});
