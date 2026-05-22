import { z } from 'zod';

import { cuid, dateOnly, positiveAmount } from './common.js';

export const allocationRowInputSchema = z.object({
  metricTypeKey: z.string().min(1),
  effectiveFrom: dateOnly,
  amount: positiveAmount,
});

export const applicationCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(60),
  description: z.string().trim().max(2000).nullish(),
  startedAt: dateOnly,
  endedAt: dateOnly.nullable().optional(),
  allocations: z.array(allocationRowInputSchema).min(1),
});

export const applicationUpdateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    category: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().max(2000).nullish(),
    startedAt: dateOnly.optional(),
    endedAt: dateOnly.nullable().optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.category !== undefined ||
      data.description !== undefined ||
      data.startedAt !== undefined ||
      data.endedAt !== undefined,
    { message: 'At least one field must be provided' },
  );

export const applicationIdParamsSchema = z.object({ id: cuid });
export const clusterIdApplicationsParamsSchema = z.object({ clusterId: cuid });

export type ApplicationCreateInput = z.infer<typeof applicationCreateInputSchema>;
export type ApplicationUpdateInput = z.infer<typeof applicationUpdateInputSchema>;
export type AllocationRowInput = z.infer<typeof allocationRowInputSchema>;

export interface AllocationResponseRow {
  id: string;
  metricTypeKey: string;
  metricTypeDisplayName: string;
  unit: string;
  effectiveFrom: string;
  amount: number;
}

export interface ApplicationResponse {
  id: string;
  clusterId: string;
  name: string;
  category: string;
  description: string | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  allocations: AllocationResponseRow[];
}
