import { z } from 'zod';

import { cuid, dateOnly, positiveAmount } from './common.js';
import type { EntitySource } from './vsphere.js';

export const capacityRowInputSchema = z.strictObject({
  metricTypeKey: z.string().min(1),
  effectiveFrom: dateOnly,
  amount: positiveAmount,
});

export const hostCreateInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullish(),
  commissionedAt: dateOnly,
  decommissionedAt: dateOnly.nullable().optional(),
  capacities: z.array(capacityRowInputSchema).min(1).max(1000),
  serialNumber: z.string().trim().max(120).nullish(),
  vendor: z.string().trim().max(120).nullish(),
  model: z.string().trim().max(120).nullish(),
  purchasedAt: dateOnly.nullable().optional(),
  warrantyEndsAt: dateOnly.nullable().optional(),
  eolAt: dateOnly.nullable().optional(),
  runPastEol: z.boolean().optional(),
});

export const hostUpdateInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullish(),
    commissionedAt: dateOnly.optional(),
    decommissionedAt: dateOnly.nullable().optional(),
    serialNumber: z.string().trim().max(120).nullish(),
    vendor: z.string().trim().max(120).nullish(),
    model: z.string().trim().max(120).nullish(),
    purchasedAt: dateOnly.nullable().optional(),
    warrantyEndsAt: dateOnly.nullable().optional(),
    eolAt: dateOnly.nullable().optional(),
    runPastEol: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      data.commissionedAt !== undefined ||
      data.decommissionedAt !== undefined ||
      data.serialNumber !== undefined ||
      data.vendor !== undefined ||
      data.model !== undefined ||
      data.purchasedAt !== undefined ||
      data.warrantyEndsAt !== undefined ||
      data.eolAt !== undefined ||
      data.runPastEol !== undefined,
    { message: 'At least one field must be provided' },
  );

/**
 * Move a host to a different cluster with a TIME-SCOPED membership (#289). The
 * move records a date: the forecast attributes the host to the *old* cluster
 * before `moveDate` and the *new* cluster on/after it, so history is never
 * retroactively rewritten (owner decision 2026-07-22). `clusterId` is the
 * DESTINATION cluster; `moveDate` is when the host moved.
 */
export const hostMoveInputSchema = z.strictObject({
  clusterId: cuid,
  moveDate: dateOnly,
});

export const hostIdParamsSchema = z.object({ id: cuid });
export const clusterIdHostsParamsSchema = z.object({ clusterId: cuid });

export type HostCreateInput = z.infer<typeof hostCreateInputSchema>;
export type HostUpdateInput = z.infer<typeof hostUpdateInputSchema>;
export type HostMoveInput = z.infer<typeof hostMoveInputSchema>;
export type CapacityRowInput = z.infer<typeof capacityRowInputSchema>;

export interface CapacityResponseRow {
  id: string;
  metricTypeKey: string;
  metricTypeDisplayName: string;
  unit: string;
  effectiveFrom: string;
  amount: number;
}

export interface HostResponse {
  id: string;
  clusterId: string;
  name: string;
  description: string | null;
  commissionedAt: string;
  decommissionedAt: string | null;
  serialNumber: string | null;
  vendor: string | null;
  model: string | null;
  purchasedAt: string | null;
  warrantyEndsAt: string | null;
  eolAt: string | null;
  runPastEol: boolean;
  state: import('./host-lifecycle.js').HostState;
  projectedDecommissionAt: string | null;
  createdAt: string;
  updatedAt: string;
  capacities: CapacityResponseRow[];
  /**
   * Where this host came from. Absent = server predates sync metadata.
   *
   * @ai-warning Do not default absence to `'manual'` — see the same warning on
   * `ClusterResponse.source`.
   */
  source?: EntitySource;
  /** Absent = server predates sync metadata. `null` = never synced. */
  lastSyncedAt?: string | null;
  /**
   * True = vCenter could not tell us when this host was commissioned, so sync
   * imported a provisional date and flagged it (owner decision Q9c). The admin
   * confirms the real date afterwards. Absent = server predates the flag; render
   * no badge.
   *
   * @ai-context The flag is not cosmetic: `commissionedAt` is NOT NULL and
   * `effectiveCapacityAt` returns 0 before it, so a wrong provisional date
   * silently flattens the historical chart. The flag is what lets the UI ask
   * rather than present a guess as a measurement.
   */
  commissionedAtProvisional?: boolean;
}
