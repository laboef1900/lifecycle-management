import { clusterCreateInputSchema } from '@lcm/shared';
import { describe, expect, it } from 'vitest';

import { parseRequiredAmount } from './required-amount';

describe('parseRequiredAmount', () => {
  it('returns NaN for a blank field instead of coercing it to 0', () => {
    // `Number('')` is 0 — the coercion this helper exists to prevent.
    expect(Number('')).toBe(0);
    expect(parseRequiredAmount('')).toBeNaN();
    expect(parseRequiredAmount('   ')).toBeNaN();
  });

  it('returns NaN for an unparseable field', () => {
    expect(parseRequiredAmount('abc')).toBeNaN();
  });

  it('parses real amounts, including a deliberately typed zero', () => {
    expect(parseRequiredAmount('512')).toBe(512);
    expect(parseRequiredAmount(' 512 ')).toBe(512);
    expect(parseRequiredAmount('1.5')).toBe(1.5);
    // A zero the operator actually typed is a statement, not an omission.
    expect(parseRequiredAmount('0')).toBe(0);
  });

  it('makes the shared schema reject a blank amount that Number() would have passed', () => {
    const withCoercion = clusterCreateInputSchema.safeParse({
      name: 'CL-1',
      baselineDate: '2026-07-01',
      baselines: [
        {
          metricTypeKey: 'memory_gb',
          baselineConsumption: Number(''),
          baselineCapacity: Number(''),
        },
      ],
    });
    // The landmine: a blank field sails through as a stored 0 GB capacity.
    expect(withCoercion.success).toBe(true);

    const withHelper = clusterCreateInputSchema.safeParse({
      name: 'CL-1',
      baselineDate: '2026-07-01',
      baselines: [
        {
          metricTypeKey: 'memory_gb',
          baselineConsumption: parseRequiredAmount(''),
          baselineCapacity: parseRequiredAmount(''),
        },
      ],
    });
    expect(withHelper.success).toBe(false);
    // The issue lands on the field's own path, so each dialog's existing
    // issue→field mapping routes it to the right input with no extra plumbing.
    expect(withHelper.success ? [] : withHelper.error.issues.map((issue) => issue.path)).toEqual([
      ['baselines', 0, 'baselineConsumption'],
      ['baselines', 0, 'baselineCapacity'],
    ]);
  });
});
