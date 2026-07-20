import { describe, expect, it } from 'vitest';

import {
  categoryCreateInputSchema,
  itemBulkShiftDatesInputSchema,
  itemCreateInputSchema,
  itemUpdateInputSchema,
  MAX_BULK_SHIFT_ITEMS,
  MAX_SHIFT_BY_UNIT,
} from '../../index.js';

describe('itemCreateInputSchema', () => {
  it('accepts an application item with allocations', () => {
    const parsed = itemCreateInputSchema.safeParse({
      kind: 'application',
      name: 'ocp-lab',
      category: 'OpenShift',
      effectiveDate: '2026-01-01',
      allocations: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-01-01', amount: 512 }],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an event item with no deltas (pure annotation)', () => {
    const parsed = itemCreateInputSchema.safeParse({
      kind: 'event',
      name: 'Migration note',
      category: 'Note',
      effectiveDate: '2026-02-01',
      metricTypeKey: 'memory_gb',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an application without allocations', () => {
    const parsed = itemCreateInputSchema.safeParse({
      kind: 'application',
      name: 'x',
      category: 'c',
      effectiveDate: '2026-01-01',
      allocations: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(
      itemCreateInputSchema.safeParse({
        kind: 'widget',
        name: 'x',
        category: 'c',
        effectiveDate: '2026-01-01',
      }).success,
    ).toBe(false);
  });
});

describe('itemUpdateInputSchema', () => {
  it('requires at least one field', () => {
    expect(itemUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(itemUpdateInputSchema.safeParse({ name: 'x' }).success).toBe(true);
  });
});

describe('categoryCreateInputSchema', () => {
  it('trims and requires a name', () => {
    expect(categoryCreateInputSchema.safeParse({ name: '  Growth ' }).success).toBe(true);
    expect(categoryCreateInputSchema.safeParse({ name: '' }).success).toBe(false);
  });
});

describe('itemBulkShiftDatesInputSchema', () => {
  const shift = { amount: 1, unit: 'months' as const };

  it('accepts a signed relative shift over a batch of ids', () => {
    expect(itemBulkShiftDatesInputSchema.safeParse({ itemIds: ['a'], shift }).success).toBe(true);
    expect(
      itemBulkShiftDatesInputSchema.safeParse({
        itemIds: ['a', 'b'],
        shift: { amount: -14, unit: 'days' },
      }).success,
    ).toBe(true);
  });

  it('rejects an empty or oversized batch', () => {
    expect(itemBulkShiftDatesInputSchema.safeParse({ itemIds: [], shift }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_BULK_SHIFT_ITEMS + 1 }, (_, i) => `id-${i}`);
    expect(itemBulkShiftDatesInputSchema.safeParse({ itemIds: tooMany, shift }).success).toBe(
      false,
    );
    const atCap = Array.from({ length: MAX_BULK_SHIFT_ITEMS }, (_, i) => `id-${i}`);
    expect(itemBulkShiftDatesInputSchema.safeParse({ itemIds: atCap, shift }).success).toBe(true);
  });

  it('rejects a zero, fractional, or over-cap shift', () => {
    const parse = (amount: number, unit: 'days' | 'weeks' | 'months'): boolean =>
      itemBulkShiftDatesInputSchema.safeParse({ itemIds: ['a'], shift: { amount, unit } }).success;

    expect(parse(0, 'months')).toBe(false);
    expect(parse(1.5, 'months')).toBe(false);
    for (const unit of ['days', 'weeks', 'months'] as const) {
      const max = MAX_SHIFT_BY_UNIT[unit];
      expect(parse(max, unit)).toBe(true);
      expect(parse(-max, unit)).toBe(true);
      expect(parse(max + 1, unit)).toBe(false);
      expect(parse(-max - 1, unit)).toBe(false);
    }
  });

  it('rejects unknown units and unknown keys', () => {
    expect(
      itemBulkShiftDatesInputSchema.safeParse({
        itemIds: ['a'],
        shift: { amount: 1, unit: 'years' },
      }).success,
    ).toBe(false);
    expect(
      itemBulkShiftDatesInputSchema.safeParse({ itemIds: ['a'], shift, setTo: '2027-01-01' })
        .success,
    ).toBe(false);
  });
});
