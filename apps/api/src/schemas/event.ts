import { z } from 'zod';

import { cuid, dateOnly } from './common.js';

export const eventCategorySchema = z.enum(['growth', 'hardware_change', 'openshift', 'note']);

export type EventCategory = z.infer<typeof eventCategorySchema>;

const deltaNumber = z.number().finite();

const hasUsefulPayload = (data: {
  category: EventCategory;
  consumptionDelta?: number | null | undefined;
  capacityDelta?: number | null | undefined;
}): boolean =>
  data.category === 'note' ||
  (data.consumptionDelta !== null && data.consumptionDelta !== undefined) ||
  (data.capacityDelta !== null && data.capacityDelta !== undefined);

export const eventCreateInputSchema = z
  .object({
    metricTypeKey: z.string().min(1),
    effectiveDate: dateOnly,
    category: eventCategorySchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullish(),
    consumptionDelta: deltaNumber.nullable().optional(),
    capacityDelta: deltaNumber.nullable().optional(),
  })
  .refine(hasUsefulPayload, {
    message: "At least one delta must be non-null unless category is 'note'",
    path: ['consumptionDelta'],
  });

export const eventUpdateInputSchema = z
  .object({
    metricTypeKey: z.string().min(1).optional(),
    effectiveDate: dateOnly.optional(),
    category: eventCategorySchema.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullish(),
    consumptionDelta: deltaNumber.nullable().optional(),
    capacityDelta: deltaNumber.nullable().optional(),
  })
  .refine(
    (data) =>
      data.metricTypeKey !== undefined ||
      data.effectiveDate !== undefined ||
      data.category !== undefined ||
      data.title !== undefined ||
      data.description !== undefined ||
      data.consumptionDelta !== undefined ||
      data.capacityDelta !== undefined,
    { message: 'At least one field must be provided' },
  );

export const eventIdParamsSchema = z.object({ id: cuid });
export const clusterIdEventsParamsSchema = z.object({ clusterId: cuid });

export type EventCreateInput = z.infer<typeof eventCreateInputSchema>;
export type EventUpdateInput = z.infer<typeof eventUpdateInputSchema>;

export interface EventResponse {
  id: string;
  clusterId: string;
  metricTypeKey: string;
  metricTypeDisplayName: string;
  unit: string;
  effectiveDate: string;
  category: EventCategory;
  title: string;
  description: string | null;
  consumptionDelta: number | null;
  capacityDelta: number | null;
  createdAt: string;
  updatedAt: string;
}

export function hasPayloadOrIsNote(args: {
  category: EventCategory;
  consumptionDelta: number | null;
  capacityDelta: number | null;
}): boolean {
  return args.category === 'note' || args.consumptionDelta !== null || args.capacityDelta !== null;
}
