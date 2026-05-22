import { z } from 'zod';

import { cuid, dateOnly, positiveAmount } from './common.js';

const metricBaselineInputSchema = z.object({
  metricTypeKey: z.string().min(1),
  baselineConsumption: positiveAmount,
  baselineCapacity: positiveAmount,
});

export const clusterCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullish(),
  baselineDate: dateOnly,
  baselines: z.array(metricBaselineInputSchema).min(1),
});

export const clusterUpdateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullish(),
    baselineDate: dateOnly.optional(),
    baselines: z.array(metricBaselineInputSchema).min(1).optional(),
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
  metrics: MetricStateResponse[];
}
