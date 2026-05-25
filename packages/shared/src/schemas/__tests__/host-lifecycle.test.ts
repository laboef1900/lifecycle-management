import { describe, it, expect } from 'vitest';

import { hostStateSchema, hostTransitionInputSchema } from '../host-lifecycle.js';
import { hostReplacementCreateInputSchema } from '../host-replacement.js';

describe('hostStateSchema', () => {
  it('accepts all six states', () => {
    for (const s of ['ordered', 'racked', 'in_service', 'degraded', 'decommissioned', 'disposed']) {
      expect(hostStateSchema.parse(s)).toBe(s);
    }
  });
  it('rejects unknown state', () => {
    expect(() => hostStateSchema.parse('retired')).toThrow();
  });
});

describe('hostTransitionInputSchema', () => {
  it('requires toState and occurredAt', () => {
    expect(() => hostTransitionInputSchema.parse({})).toThrow();
    expect(
      hostTransitionInputSchema.parse({ toState: 'degraded', occurredAt: '2026-05-25' }),
    ).toMatchObject({ toState: 'degraded', occurredAt: new Date('2026-05-25') });
  });
  it('accepts an optional note', () => {
    const parsed = hostTransitionInputSchema.parse({
      toState: 'decommissioned',
      occurredAt: '2026-05-25',
      note: 'planned',
    });
    expect(parsed.note).toBe('planned');
  });
});

describe('hostReplacementCreateInputSchema', () => {
  it('requires both host ids and swappedAt', () => {
    expect(() => hostReplacementCreateInputSchema.parse({})).toThrow();
    const valid = {
      oldHostId: 'cjld2cyuq0000t3rmniod1foy',
      newHostId: 'cjld2cyuq0001t3rmqyl2c6rs',
      swappedAt: '2026-05-25',
    };
    const parsed = hostReplacementCreateInputSchema.parse(valid);
    expect(parsed.oldHostId).toBe(valid.oldHostId);
  });
});
