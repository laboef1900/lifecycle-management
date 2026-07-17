import { z } from 'zod';

import { cuid, dateOnly, positiveAmount } from './common.js';
import { paginationQuerySchema } from './pagination.js';
import type { EntitySource, VsphereConnectionStatus } from './vsphere.js';

const metricBaselineInputSchema = z.strictObject({
  metricTypeKey: z.string().min(1),
  baselineConsumption: positiveAmount,
  baselineCapacity: positiveAmount,
});

export const clusterCreateInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullish(),
  baselineDate: dateOnly,
  baselines: z.array(metricBaselineInputSchema).min(1).max(50),
});

export const clusterUpdateInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullish(),
    baselineDate: dateOnly.optional(),
    baselines: z.array(metricBaselineInputSchema).min(1).max(50).optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      data.baselineDate !== undefined ||
      data.baselines !== undefined,
    { message: 'At least one field must be provided' },
  );

export const clusterIdParamsSchema = z.object({ id: cuid });

export const clustersListQuerySchema = paginationQuerySchema.extend({
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
});

export type ClustersListQuery = z.infer<typeof clustersListQuerySchema>;

export type ClusterCreateInput = z.infer<typeof clusterCreateInputSchema>;
export type ClusterUpdateInput = z.infer<typeof clusterUpdateInputSchema>;

export interface MetricStateResponse {
  metricTypeKey: string;
  metricTypeDisplayName: string;
  unit: string;
  baselineConsumption: number;
  baselineCapacity: number;
  currentConsumption: number;
  currentCapacity: number;
  utilization: number;
}

/**
 * A cluster as served to clients.
 *
 * @ai-warning Every sync field below is OPTIONAL by construction, and that is
 * load-bearing rather than stylistic: it is what lets this contract merge ahead
 * of the server that populates it. A required field would break
 * `ClustersService.toResponse` at compile time and drag the server into what is
 * meant to be a shared-only change.
 */
export interface ClusterResponse {
  id: string;
  name: string;
  description: string | null;
  baselineDate: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  metrics: MetricStateResponse[];
  /**
   * Where this cluster came from. Absent = this server build predates sync
   * metadata.
   *
   * @ai-warning Absence MUST NOT be defaulted to `'manual'` — not here, not with
   * `.default()`, not with `?? 'manual'` at a call site. It typechecks and it
   * looks harmless because `manual` is the DB default, but it turns "this server
   * does not know" into a definite, reassuring answer and destroys the only
   * signal a client has for "is this deployment new enough?". Same shape as the
   * `utilization ?? 0` fail-open. Absence must stay legible as absence.
   */
  source?: EntitySource;
  /**
   * Absent = server predates sync metadata. `null` = sync-capable server, and
   * this cluster has never synced. Two different facts; collapsing them means a
   * client cannot tell an old deployment from a manual cluster.
   */
  lastSyncedAt?: string | null;
  /**
   * The raw vCenter name, verbatim and sync-owned — whereas `name` is the
   * LCM-owned display label, seeded from vCenter and permanently sync-immune
   * once an operator edits it. When the two disagree, vCenter was renamed: that
   * is surfaced as a hint, never by clobbering a deliberate choice.
   */
  externalName?: string | null;
  /**
   * The vCenter this cluster syncs from. `null` = manual cluster (no connection).
   * Denormalized deliberately: the fleet console needs the connection's name and
   * health to render a per-cluster badge, and an id alone would force a second
   * round-trip per tile.
   */
  connection?: {
    id: string;
    name: string;
    status: VsphereConnectionStatus;
    enabled: boolean;
  } | null;
}
