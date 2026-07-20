import { z } from 'zod';

import type { DateShiftUnit } from '../dates.js';

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

// ---------- Bulk relative date shift ----------

/**
 * Upper bound on one bulk shift. Each entry costs one row update plus one per
 * allocation row, all inside a single serializable transaction, so this is a
 * transaction-size bound as much as an abuse bound.
 */
export const MAX_BULK_SHIFT_ITEMS = 100;

/** Per-unit magnitude caps — the same horizon expressed three ways (~10 years). */
export const MAX_SHIFT_BY_UNIT: Readonly<Record<DateShiftUnit, number>> = {
  days: 3650,
  weeks: 520,
  months: 120,
};

export const dateShiftUnitSchema = z.enum(['days', 'weeks', 'months']);

/**
 * A signed relative shift. Negative moves entries earlier, positive later; zero
 * is rejected because it is always an operator mistake, never an intent.
 *
 * @ai-note There is deliberately no absolute "set every entry to this date"
 * mode — relative shift is the whole contract for now (owner decision on #256).
 */
export const itemDateShiftSchema = z
  .strictObject({
    amount: z.number().int(),
    unit: dateShiftUnitSchema,
  })
  .superRefine((shift, ctx) => {
    if (shift.amount === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Shift amount must not be zero',
      });
      return;
    }
    const max = MAX_SHIFT_BY_UNIT[shift.unit];
    if (Math.abs(shift.amount) > max) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: `Shift amount must be between -${max} and ${max} ${shift.unit}`,
      });
    }
  });

/**
 * @ai-warning NOT idempotent by construction: a relative shift applied twice
 * moves the entries twice. A retry after an ambiguous failure must re-read the
 * entries first. Deliberate — an idempotency key was out of scope for #256.
 */
export const itemBulkShiftDatesInputSchema = z.strictObject({
  itemIds: z.array(cuid).min(1).max(MAX_BULK_SHIFT_ITEMS),
  shift: itemDateShiftSchema,
});

export type ItemCreateInput = z.infer<typeof itemCreateInputSchema>;
export type ItemUpdateInput = z.infer<typeof itemUpdateInputSchema>;
export type ItemAllocationRowInput = z.infer<typeof itemAllocationRowInputSchema>;
export type ItemDateShift = z.infer<typeof itemDateShiftSchema>;
export type ItemBulkShiftDatesInput = z.infer<typeof itemBulkShiftDatesInputSchema>;

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

export interface ItemBulkShiftDatesResponse {
  /** How many entries were moved — always `items.length`, stated for the toast. */
  shifted: number;
  /** The entries as they now stand, in the order the server resolved them. */
  items: ItemResponse[];
}
