import { z } from 'zod';

import { cuid, dateOnly, positiveAmount } from './common.js';
import { paginationQuerySchema } from './pagination.js';

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

export interface ClusterResponse {
  id: string;
  name: string;
  description: string | null;
  baselineDate: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  metrics: MetricStateResponse[];
}
