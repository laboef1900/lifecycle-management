import { describe, expect, it } from 'vitest';

import {
  HOST_COMMISSIONING_CONFIRM_MAX,
  hostCommissioningConfirmInputSchema,
} from '../host-commissioning.js';

describe('hostCommissioningConfirmInputSchema', () => {
  it('parses a batch, transforming each YYYY-MM-DD to a UTC Date', () => {
    const parsed = hostCommissioningConfirmInputSchema.parse({
      hosts: [
        { hostId: 'h1', commissionedAt: '2026-01-15' },
        { hostId: 'h2', commissionedAt: '2025-11-01' },
      ],
    });
    expect(parsed.hosts).toHaveLength(2);
    expect(parsed.hosts[0]?.commissionedAt.toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  it('rejects an empty batch — confirming nothing is meaningless', () => {
    expect(hostCommissioningConfirmInputSchema.safeParse({ hosts: [] }).success).toBe(false);
  });

  it('rejects a batch larger than the bound (the body limit is not a substitute)', () => {
    const hosts = Array.from({ length: HOST_COMMISSIONING_CONFIRM_MAX + 1 }, (_, i) => ({
      hostId: `h${i}`,
      commissionedAt: '2026-01-01',
    }));
    expect(hostCommissioningConfirmInputSchema.safeParse({ hosts }).success).toBe(false);
  });

  it('rejects a duplicated hostId — a double-write would be ambiguous last-wins', () => {
    const result = hostCommissioningConfirmInputSchema.safeParse({
      hosts: [
        { hostId: 'dup', commissionedAt: '2026-01-01' },
        { hostId: 'dup', commissionedAt: '2026-02-01' },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['hosts']);
    }
  });

  it('rejects a malformed date', () => {
    const result = hostCommissioningConfirmInputSchema.safeParse({
      hosts: [{ hostId: 'h1', commissionedAt: '01/15/2026' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys on an entry (strict)', () => {
    const result = hostCommissioningConfirmInputSchema.safeParse({
      hosts: [{ hostId: 'h1', commissionedAt: '2026-01-15', backdateCapacity: true }],
    });
    expect(result.success).toBe(false);
  });
});
