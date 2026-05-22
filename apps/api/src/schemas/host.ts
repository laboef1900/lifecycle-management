import { z } from 'zod';

import { cuid, dateOnly, positiveAmount } from './common.js';

export const capacityRowInputSchema = z.object({
  metricTypeKey: z.string().min(1),
  effectiveFrom: dateOnly,
  amount: positiveAmount,
});

export const hostCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullish(),
  commissionedAt: dateOnly,
  decommissionedAt: dateOnly.nullable().optional(),
  capacities: z.array(capacityRowInputSchema).min(1),
});

export const hostUpdateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullish(),
    commissionedAt: dateOnly.optional(),
    decommissionedAt: dateOnly.nullable().optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      data.commissionedAt !== undefined ||
      data.decommissionedAt !== undefined,
    { message: 'At least one field must be provided' },
  );

export const hostIdParamsSchema = z.object({ id: cuid });
export const clusterIdHostsParamsSchema = z.object({ clusterId: cuid });

export type HostCreateInput = z.infer<typeof hostCreateInputSchema>;
export type HostUpdateInput = z.infer<typeof hostUpdateInputSchema>;
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
  createdAt: string;
  updatedAt: string;
  capacities: CapacityResponseRow[];
}
