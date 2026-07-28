import { describe, expect, it } from 'vitest';

import {
  forecastQuerySchema,
  MAX_FORECAST_SPAN_MONTHS,
  MAX_SCENARIO_STEPS,
  scenarioRequestSchema,
  scenarioStackSchema,
} from '../forecast.js';

describe('forecastQuerySchema range bounds', () => {
  it('rejects from > to', () => {
    const r = forecastQuerySchema.safeParse({
      metric: 'memory_gb',
      from: '2027-01',
      to: '2026-01',
    });
    expect(r.success).toBe(false);
  });
  it('rejects spans over MAX_FORECAST_SPAN_MONTHS', () => {
    const r = forecastQuerySchema.safeParse({
      metric: 'memory_gb',
      from: '2026-01',
      to: '2999-12',
    });
    expect(r.success).toBe(false);
  });
  it('accepts a 24-month window', () => {
    const r = forecastQuerySchema.safeParse({
      metric: 'memory_gb',
      from: '2026-01',
      to: '2027-12',
    });
    expect(r.success).toBe(true);
  });
  it('still accepts omitted bounds', () => {
    expect(forecastQuerySchema.safeParse({ metric: 'memory_gb' }).success).toBe(true);
  });
  it('exports a 120-month cap', () => {
    expect(MAX_FORECAST_SPAN_MONTHS).toBe(120);
  });
});

describe('scenarioStackSchema (#323)', () => {
  it('accepts a compound of distinct kinds and parses startMonth to a Date', () => {
    const r = scenarioStackSchema.safeParse({
      steps: [
        { kind: 'lose_hosts', count: 2 },
        { kind: 'add_vms', count: 10, sizeGb: 16, startMonth: '2026-09' },
        { kind: 'delay_procurement', months: 3 },
      ],
    });
    expect(r.success).toBe(true);
    const step = r.data?.steps[1];
    expect(step?.kind).toBe('add_vms');
    // monthOnly transforms 'YYYY-MM' to the first of that UTC month.
    expect(step?.kind === 'add_vms' && step.startMonth?.toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });

  it('rejects a duplicate kind — the id-collision guard, not a UI rule', () => {
    const r = scenarioStackSchema.safeParse({
      steps: [
        { kind: 'add_vms', count: 10, sizeGb: 16 },
        { kind: 'add_vms', count: 10, sizeGb: 16 },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('Each scenario kind may appear at most once');
  });

  it(`rejects more than MAX_SCENARIO_STEPS (${MAX_SCENARIO_STEPS}) steps`, () => {
    // Distinct kinds are exhausted at 3, so a 4th step trips the cap on its own.
    const r = scenarioStackSchema.safeParse({
      steps: [
        { kind: 'lose_hosts', count: 1 },
        { kind: 'add_vms', count: 1, sizeGb: 1 },
        { kind: 'delay_procurement', months: 1 },
        { kind: 'lose_hosts', count: 2 },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an empty stack', () => {
    expect(scenarioStackSchema.safeParse({ steps: [] }).success).toBe(false);
  });

  it('rejects an invalid step inside an otherwise valid stack', () => {
    const r = scenarioStackSchema.safeParse({
      steps: [{ kind: 'lose_hosts', count: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a mistyped container key instead of silently dropping the stack', () => {
    // strictObject: `parts` is both an unknown key and a missing `steps`. Were
    // this a plain z.object, `parts` would be stripped and `steps` would fail —
    // still a 400, but the union below could then have matched nothing useful.
    expect(
      scenarioStackSchema.safeParse({ parts: [{ kind: 'lose_hosts', count: 1 }] }).success,
    ).toBe(false);
  });
});

describe('scenarioRequestSchema — additive single/stack union (#323)', () => {
  it('normalises a bare single scenario to a one-step stack (back-compat)', () => {
    const r = scenarioRequestSchema.safeParse({ kind: 'lose_hosts', count: 2 });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ steps: [{ kind: 'lose_hosts', count: 2 }] });
  });

  it('passes a stack through unchanged', () => {
    const r = scenarioRequestSchema.safeParse({
      steps: [
        { kind: 'lose_hosts', count: 1 },
        { kind: 'delay_procurement', months: 6 },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data?.steps.map((s) => s.kind)).toEqual(['lose_hosts', 'delay_procurement']);
  });

  it('rejects an unknown kind in either form', () => {
    expect(scenarioRequestSchema.safeParse({ kind: 'nope' }).success).toBe(false);
    expect(scenarioRequestSchema.safeParse({ steps: [{ kind: 'nope' }] }).success).toBe(false);
  });

  it('rejects a body that is neither shape', () => {
    expect(scenarioRequestSchema.safeParse({}).success).toBe(false);
    expect(scenarioRequestSchema.safeParse({ count: 2 }).success).toBe(false);
  });
});
