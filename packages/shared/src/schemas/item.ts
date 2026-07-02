import { z } from 'zod';

import { cuid, dateOnly, MAX_AMOUNT, positiveAmount } from './common.js';

export const itemKindSchema = z.enum(['application', 'event']);
export type ItemKind = z.infer<typeof itemKindSchema>;

const deltaNumber = z.number().finite().min(-MAX_AMOUNT).max(MAX_AMOUNT);

export const itemAllocationRowInputSchema = z.strictObject({
  metricTypeKey: z.string().min(1),
  effectiveFrom: dateOnly,
  amount: positiveAmount,
});

const baseFields = {
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(60),
  description: z.string().trim().max(2000).nullish(),
  effectiveDate: dateOnly,
};

export const applicationItemCreateSchema = z.strictObject({
  kind: z.literal('application'),
  ...baseFields,
  endedAt: dateOnly.nullable().optional(),
  allocations: z.array(itemAllocationRowInputSchema).min(1).max(1000),
});

export const eventItemCreateSchema = z.strictObject({
  kind: z.literal('event'),
  ...baseFields,
  metricTypeKey: z.string().min(1),
  // Deltas are optional: an event may be a pure annotation (no forecast impact) for ANY category.
  // The old "non-note events must carry a delta" rule is intentionally dropped now that categories
  // are free-form.
  consumptionDelta: deltaNumber.nullable().optional(),
  capacityDelta: deltaNumber.nullable().optional(),
});

export const itemCreateInputSchema = z.discriminatedUnion('kind', [
  applicationItemCreateSchema,
  eventItemCreateSchema,
]);

// Update: kind is immutable, so it is NOT part of the body. All fields optional;
// the service applies them based on the stored kind.
export const itemUpdateInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    category: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().max(2000).nullish(),
    effectiveDate: dateOnly.optional(),
    endedAt: dateOnly.nullable().optional(),
    metricTypeKey: z.string().min(1).optional(),
    consumptionDelta: deltaNumber.nullable().optional(),
    capacityDelta: deltaNumber.nullable().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

export const itemIdParamsSchema = z.object({ id: cuid });
export const clusterIdItemsParamsSchema = z.object({ clusterId: cuid });

export type ItemCreateInput = z.infer<typeof itemCreateInputSchema>;
export type ItemUpdateInput = z.infer<typeof itemUpdateInputSchema>;
export type ItemAllocationRowInput = z.infer<typeof itemAllocationRowInputSchema>;

export interface ItemAllocationResponseRow {
  id: string;
  metricTypeKey: string;
  metricTypeDisplayName: string;
  unit: string;
  effectiveFrom: string;
  amount: number;
}

export interface ItemResponse {
  id: string;
  clusterId: string;
  kind: ItemKind;
  name: string;
  category: string;
  description: string | null;
  effectiveDate: string;
  endedAt: string | null;
  metricTypeKey: string | null;
  consumptionDelta: number | null;
  capacityDelta: number | null;
  allocations: ItemAllocationResponseRow[];
  createdAt: string;
  updatedAt: string;
}
