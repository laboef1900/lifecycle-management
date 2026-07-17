import { z } from 'zod';

import type { CategoryResponse } from './category.js';
import type { ClusterResponse, MetricStateResponse } from './cluster.js';
import type {
  BaselineHistoryPoint,
  ForecastEntityContribution,
  ForecastEventMarker,
  ForecastMonthPoint,
  ForecastResponse,
  ProcurementInfo,
} from './forecast.js';
import { hostStateSchema } from './host-lifecycle.js';
import type { HostLifecycleEventResponse } from './host-lifecycle.js';
import type { HostReplacementResponse } from './host-replacement.js';
import type { CapacityResponseRow, HostResponse } from './host.js';
import { itemKindSchema } from './item.js';
import type { ItemAllocationResponseRow, ItemResponse } from './item.js';
import type { Paginated } from './pagination.js';
import {
  effectiveThresholdsSchema,
  percentSchema,
  procurementLeadTimeWeeksSchema,
} from './settings.js';
import type { TenantSettings } from './settings.js';
import {
  entitySourceSchema,
  vsphereConnectionStatusSchema,
  vsphereSyncOutcomeSchema,
  vsphereTlsModeSchema,
} from './vsphere.js';
import type {
  VsphereConnectionResponse,
  VsphereProbeResult,
  VsphereVerifyResult,
} from './vsphere.js';

// ---------- Clusters ----------

export const metricStateResponseSchema: z.ZodType<MetricStateResponse> = z.object({
  metricTypeKey: z.string(),
  metricTypeDisplayName: z.string(),
  unit: z.string(),
  baselineConsumption: z.number(),
  baselineCapacity: z.number(),
  currentConsumption: z.number(),
  currentCapacity: z.number(),
  utilization: z.number(),
});

// The sync fields use `.exactOptional()`, NOT `.optional()`. Under
// `exactOptionalPropertyTypes` a `.optional()` here does not compile against
// `source?: EntitySource` (TS2375), and the compiler's suggested fix — widen the
// interface to `EntitySource | undefined` — must NOT be taken: it makes
// `{ source: undefined }` legal everywhere and reopens the hole these fields are
// shaped to close. See `forecastEntityContributionSchema` for the same pattern.
export const clusterResponseSchema: z.ZodType<ClusterResponse> = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  baselineDate: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  metrics: z.array(metricStateResponseSchema),
  source: entitySourceSchema.exactOptional(),
  lastSyncedAt: z.string().nullable().exactOptional(),
  externalName: z.string().nullable().exactOptional(),
  connection: z
    .object({
      id: z.string(),
      name: z.string(),
      status: vsphereConnectionStatusSchema,
      enabled: z.boolean(),
    })
    .nullable()
    .exactOptional(),
});

// ---------- Hosts ----------

export const capacityResponseRowSchema: z.ZodType<CapacityResponseRow> = z.object({
  id: z.string(),
  metricTypeKey: z.string(),
  metricTypeDisplayName: z.string(),
  unit: z.string(),
  effectiveFrom: z.string(),
  amount: z.number(),
});

export const hostResponseSchema: z.ZodType<HostResponse> = z.object({
  id: z.string(),
  clusterId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  commissionedAt: z.string(),
  decommissionedAt: z.string().nullable(),
  serialNumber: z.string().nullable(),
  vendor: z.string().nullable(),
  model: z.string().nullable(),
  purchasedAt: z.string().nullable(),
  warrantyEndsAt: z.string().nullable(),
  eolAt: z.string().nullable(),
  runPastEol: z.boolean(),
  state: hostStateSchema,
  projectedDecommissionAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  capacities: z.array(capacityResponseRowSchema),
  source: entitySourceSchema.exactOptional(),
  lastSyncedAt: z.string().nullable().exactOptional(),
  commissionedAtProvisional: z.boolean().exactOptional(),
});

// ---------- Items ----------

export const itemAllocationResponseRowSchema: z.ZodType<ItemAllocationResponseRow> = z.object({
  id: z.string(),
  metricTypeKey: z.string(),
  metricTypeDisplayName: z.string(),
  unit: z.string(),
  effectiveFrom: z.string(),
  amount: z.number(),
});

export const itemResponseSchema: z.ZodType<ItemResponse> = z.object({
  id: z.string(),
  clusterId: z.string(),
  kind: itemKindSchema,
  name: z.string(),
  category: z.string(),
  description: z.string().nullable(),
  effectiveDate: z.string(),
  endedAt: z.string().nullable(),
  metricTypeKey: z.string().nullable(),
  consumptionDelta: z.number().nullable(),
  capacityDelta: z.number().nullable(),
  allocations: z.array(itemAllocationResponseRowSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------- Forecast ----------

export const forecastMonthPointSchema: z.ZodType<ForecastMonthPoint> = z.object({
  month: z.string(),
  consumption: z.number(),
  capacity: z.number(),
  // Nullable by contract: null means "capacity is 0, so utilization is
  // unknowable" — never 0. See ForecastMonthPoint in forecast.ts (Q9d).
  utilization: z.number().nullable(),
});

export const baselineHistoryPointSchema: z.ZodType<BaselineHistoryPoint> = z.object({
  capturedAt: z.string(),
  source: z.enum(['manual', 'vsphere']),
  consumption: z.number(),
  capacity: z.number(),
  utilization: z.number().nullable(),
});

export const forecastEventMarkerSchema: z.ZodType<ForecastEventMarker> = z.object({
  id: z.string(),
  effectiveDate: z.string(),
  category: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  consumptionDelta: z.number().nullable(),
  capacityDelta: z.number().nullable(),
});

export const forecastEntityContributionSchema: z.ZodType<ForecastEntityContribution> = z.object({
  id: z.string(),
  name: z.string(),
  projectedDecommissionAt: z.string().nullable().exactOptional(),
  contributions: z.array(z.object({ month: z.string(), amount: z.number() })),
});

export const procurementInfoSchema: z.ZodType<ProcurementInfo> = z.object({
  leadTimeWeeks: z.number(),
  orderByDate: z.string().nullable(),
  breachMonth: z.string().nullable(),
});

export const forecastResponseSchema: z.ZodType<ForecastResponse> = z.object({
  fromMonth: z.string(),
  toMonth: z.string(),
  months: z.array(forecastMonthPointSchema),
  events: z.array(forecastEventMarkerSchema),
  hosts: z.array(forecastEntityContributionSchema),
  applications: z.array(forecastEntityContributionSchema),
  effectiveThresholds: effectiveThresholdsSchema,
  procurement: procurementInfoSchema,
  baselineHistory: z.array(baselineHistoryPointSchema),
});

// ---------- Categories ----------

export const categoryResponseSchema: z.ZodType<CategoryResponse> = z.object({
  id: z.string(),
  name: z.string(),
});

// ---------- Host lifecycle ----------

export const hostLifecycleEventResponseSchema: z.ZodType<HostLifecycleEventResponse> = z.object({
  id: z.string(),
  hostId: z.string(),
  fromState: hostStateSchema.nullable(),
  toState: hostStateSchema,
  occurredAt: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
});

// ---------- Host replacements ----------

export const hostReplacementResponseSchema: z.ZodType<HostReplacementResponse> = z.object({
  id: z.string(),
  oldHostId: z.string(),
  newHostId: z.string(),
  swappedAt: z.string(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});

// ---------- Settings ----------

// Non-strict on purpose: responses tolerate additive server fields
// (forward compatibility); the server enforces warn < crit on write.
export const tenantSettingsResponseSchema: z.ZodType<TenantSettings> = z.object({
  warnThreshold: percentSchema,
  critThreshold: percentSchema,
  procurementLeadTimeWeeks: procurementLeadTimeWeeksSchema,
});

// ---------- Pagination envelope ----------

export function paginatedSchema<T>(item: z.ZodType<T>): z.ZodType<Paginated<T>> {
  return z.object({
    items: z.array(item),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  });
}

// ---------- vSphere connections ----------

/**
 * @ai-warning There is no `password` field, and there must never be one — not even
 * redacted. This schema is the serialization boundary, so a field added here is a
 * field that reaches the client.
 */
export const vsphereConnectionResponseSchema: z.ZodType<VsphereConnectionResponse> = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  username: z.string(),
  tlsMode: vsphereTlsModeSchema,
  pinnedRootFingerprintSha256: z.string().nullable(),
  instanceUuid: z.string().nullable(),
  apiVersion: z.string().nullable(),
  enabled: z.boolean(),
  status: vsphereConnectionStatusSchema,
  lastError: z.string().nullable(),
  lastConnectedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  syncState: z
    .object({
      lastSyncAt: z.string().nullable(),
      lastSyncStatus: vsphereSyncOutcomeSchema.nullable(),
      lastSnapshotAt: z.string().nullable(),
      lastSnapshotStatus: z.string().nullable(),
      lastSuccessPeriod: z.string().nullable(),
      failureCount: z.number().int(),
    })
    .nullable()
    .exactOptional(),
});

export const vsphereProbeResultSchema: z.ZodType<VsphereProbeResult> = z.object({
  reachable: z.boolean(),
  trustedBySystemRoots: z.boolean(),
  rootFingerprintSha256: z.string().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  outcome: z.enum(['ok', 'unreachable', 'tls_untrusted', 'not_a_vcenter']),
});

export const vsphereVerifyResultSchema: z.ZodType<VsphereVerifyResult> = z.object({
  outcome: z.enum(['ok', 'unreachable', 'tls_untrusted', 'not_a_vcenter', 'auth_failed']),
  instanceUuid: z.string().nullable(),
  apiVersion: z.string().nullable(),
});
