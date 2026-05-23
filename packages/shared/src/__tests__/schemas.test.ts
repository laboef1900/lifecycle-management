import { describe, expect, it } from 'vitest';

import {
  allocationRowInputSchema,
  applicationCreateInputSchema,
  applicationUpdateInputSchema,
  capacityRowInputSchema,
  clusterCreateInputSchema,
  clusterUpdateInputSchema,
  eventCreateInputSchema,
  eventUpdateInputSchema,
  forecastQuerySchema,
  hasPayloadOrIsNote,
  hostCreateInputSchema,
  hostUpdateInputSchema,
} from '../index.js';

/**
 * Round-trip a wire object: parse it, then serialize the parsed result
 * back to the wire form (Date -> YYYY-MM-DD), re-parse, and assert that
 * the second parse equals the first. This proves the schema's parse +
 * its inverse serialization are mutually consistent.
 */
function roundTrip<T>(schema: { parse: (input: unknown) => T }, wire: unknown): T {
  const parsed = schema.parse(wire);
  const serialized = serializeForWire(parsed);
  const reparsed = schema.parse(serialized);
  expect(reparsed).toEqual(parsed);
  return parsed;
}

function serializeForWire(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (Array.isArray(value)) {
    return value.map(serializeForWire);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeForWire(v);
    }
    return out;
  }
  return value;
}

describe('cluster schemas', () => {
  it('round-trips a valid create payload', () => {
    const parsed = roundTrip(clusterCreateInputSchema, {
      name: 'CL-DMZ-P1',
      description: 'DMZ Production cluster 1',
      baselineDate: '2026-05-01',
      baselines: [
        {
          metricTypeKey: 'memory_gb',
          baselineConsumption: 3378,
          baselineCapacity: 7680,
        },
      ],
    });
    expect(parsed.baselineDate).toBeInstanceOf(Date);
    expect(parsed.baselines[0]?.baselineCapacity).toBe(7680);
  });

  it('rejects an empty baselines array', () => {
    expect(() =>
      clusterCreateInputSchema.parse({
        name: 'x',
        baselineDate: '2026-05-01',
        baselines: [],
      }),
    ).toThrow();
  });

  it('requires at least one field on update', () => {
    expect(() => clusterUpdateInputSchema.parse({})).toThrow();
    expect(() => clusterUpdateInputSchema.parse({ name: 'renamed' })).not.toThrow();
  });
});

describe('host schemas', () => {
  it('round-trips a valid create payload', () => {
    const parsed = roundTrip(hostCreateInputSchema, {
      name: 'hpe-01',
      commissionedAt: '2026-05-01',
      capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: 512 }],
    });
    expect(parsed.commissionedAt).toBeInstanceOf(Date);
    expect(parsed.capacities[0]?.amount).toBe(512);
  });

  it('round-trips a capacity append payload', () => {
    const parsed = roundTrip(capacityRowInputSchema, {
      metricTypeKey: 'memory_gb',
      effectiveFrom: '2027-01-01',
      amount: 1024,
    });
    expect(parsed.amount).toBe(1024);
  });

  it('rejects a negative amount', () => {
    expect(() =>
      hostCreateInputSchema.parse({
        name: 'x',
        commissionedAt: '2026-05-01',
        capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-05-01', amount: -1 }],
      }),
    ).toThrow();
  });

  it('requires at least one field on update', () => {
    expect(() => hostUpdateInputSchema.parse({})).toThrow();
    expect(() => hostUpdateInputSchema.parse({ decommissionedAt: '2027-12-31' })).not.toThrow();
  });
});

describe('application schemas', () => {
  it('round-trips a valid create payload', () => {
    const parsed = roundTrip(applicationCreateInputSchema, {
      name: 'openshift-lab',
      category: 'openshift',
      startedAt: '2026-08-01',
      allocations: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-08-01', amount: 144 }],
    });
    expect(parsed.category).toBe('openshift');
  });

  it('round-trips an allocation append payload', () => {
    const parsed = roundTrip(allocationRowInputSchema, {
      metricTypeKey: 'memory_gb',
      effectiveFrom: '2027-02-01',
      amount: 576,
    });
    expect(parsed.amount).toBe(576);
  });

  it('requires at least one field on update', () => {
    expect(() => applicationUpdateInputSchema.parse({})).toThrow();
    expect(() => applicationUpdateInputSchema.parse({ name: 'x' })).not.toThrow();
  });
});

describe('event schemas', () => {
  it('round-trips a growth event with a consumption delta', () => {
    const parsed = roundTrip(eventCreateInputSchema, {
      metricTypeKey: 'memory_gb',
      effectiveDate: '2026-10-01',
      category: 'growth',
      title: 'Wachstum Q4',
      consumptionDelta: 750,
    });
    expect(parsed.consumptionDelta).toBe(750);
    expect(parsed.capacityDelta).toBeUndefined();
  });

  it('accepts a note event with both deltas null', () => {
    const parsed = eventCreateInputSchema.parse({
      metricTypeKey: 'memory_gb',
      effectiveDate: '2026-06-01',
      category: 'note',
      title: 'OpenShift go-live',
      consumptionDelta: null,
      capacityDelta: null,
    });
    expect(parsed.category).toBe('note');
  });

  it('rejects a growth event with no deltas', () => {
    expect(() =>
      eventCreateInputSchema.parse({
        metricTypeKey: 'memory_gb',
        effectiveDate: '2026-10-01',
        category: 'growth',
        title: 'empty',
      }),
    ).toThrow();
  });

  it('hasPayloadOrIsNote matches the schema refine', () => {
    expect(
      hasPayloadOrIsNote({ category: 'note', consumptionDelta: null, capacityDelta: null }),
    ).toBe(true);
    expect(
      hasPayloadOrIsNote({ category: 'growth', consumptionDelta: 100, capacityDelta: null }),
    ).toBe(true);
    expect(
      hasPayloadOrIsNote({ category: 'growth', consumptionDelta: null, capacityDelta: null }),
    ).toBe(false);
  });

  it('requires at least one field on update', () => {
    expect(() => eventUpdateInputSchema.parse({})).toThrow();
    expect(() => eventUpdateInputSchema.parse({ title: 'new' })).not.toThrow();
  });
});

describe('forecast query schema', () => {
  it('parses a YYYY-MM month into a UTC first-of-month Date', () => {
    const parsed = forecastQuerySchema.parse({
      metric: 'memory_gb',
      from: '2026-05',
      to: '2027-12',
    });
    expect(parsed.from?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(parsed.to?.toISOString()).toBe('2027-12-01T00:00:00.000Z');
  });

  it('rejects a YYYY-MM-DD value in a month field', () => {
    expect(() => forecastQuerySchema.parse({ metric: 'memory_gb', from: '2026-05-01' })).toThrow();
  });
});
