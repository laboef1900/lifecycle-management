import { describe, expect, it } from 'vitest';

import {
  categoryCreateInputSchema,
  itemCreateInputSchema,
  itemUpdateInputSchema,
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
