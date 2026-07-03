import { describe, expect, it } from 'vitest';
import {
  clusterCreateInputSchema,
  hostCreateInputSchema,
  itemCreateInputSchema,
} from '../../index.js';

const cap = (i: number) => ({ metricTypeKey: 'memory_gb', effectiveFrom: '2026-01-01', amount: i });

describe('input bounds', () => {
  it('rejects amounts above 1e12', () => {
    expect(
      hostCreateInputSchema.safeParse({
        name: 'h',
        commissionedAt: '2026-01-01',
        capacities: [{ ...cap(0), amount: 1e13 }],
      }).success,
    ).toBe(false);
  });
  it('rejects more than 1000 capacity rows', () => {
    expect(
      hostCreateInputSchema.safeParse({
        name: 'h',
        commissionedAt: '2026-01-01',
        capacities: Array.from({ length: 1001 }, (_, i) => cap(i)),
      }).success,
    ).toBe(false);
  });
  it('rejects more than 50 baselines', () => {
    expect(
      clusterCreateInputSchema.safeParse({
        name: 'c',
        baselineDate: '2026-01-01',
        baselines: Array.from({ length: 51 }, (_, i) => ({
          metricTypeKey: `m${i}`,
          baselineConsumption: 1,
          baselineCapacity: 2,
        })),
      }).success,
    ).toBe(false);
  });
  it('rejects unknown keys on create bodies', () => {
    expect(
      itemCreateInputSchema.safeParse({
        kind: 'event',
        name: 'e',
        category: 'Growth',
        effectiveDate: '2026-01-01',
        metricTypeKey: 'memory_gb',
        evil: true,
      }).success,
    ).toBe(false);
  });
});
