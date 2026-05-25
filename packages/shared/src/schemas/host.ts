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
  serialNumber: z.string().trim().max(120).nullish(),
  vendor: z.string().trim().max(120).nullish(),
  model: z.string().trim().max(120).nullish(),
  purchasedAt: dateOnly.nullable().optional(),
  warrantyEndsAt: dateOnly.nullable().optional(),
  eolAt: dateOnly.nullable().optional(),
  runPastEol: z.boolean().optional(),
});

export const hostUpdateInputSchema = z
  .object({
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
  .strict()
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
}
