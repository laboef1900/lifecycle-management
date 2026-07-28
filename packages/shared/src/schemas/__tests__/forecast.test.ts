import { describe, expect, it } from 'vitest';

import {
  forecastQuerySchema,
  MAX_FORECAST_SPAN_MONTHS,
  MAX_SCENARIO_STEPS,
  scenarioRequestSchema,
  scenarioStackSchema,
  type ScenarioRequestWire,
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

  /**
   * @ai-warning The `.max()` cap and the uniqueness refine are CONFOUNDED by the
   * pigeonhole principle: there are exactly three kinds, so any array long enough
   * to exceed the cap necessarily repeats one, and a bare `success === false`
   * assertion here passes with `.max(MAX_SCENARIO_STEPS)` deleted entirely (AI
   * review verified that by removing it). So this asserts the cap's OWN issue —
   * `too_big` — not merely that the body was rejected. That keeps the cap covered
   * for its actual purpose: bounding the stack once a fourth kind exists and
   * uniqueness stops implying a bound.
   */
  it(`rejects more than MAX_SCENARIO_STEPS (${MAX_SCENARIO_STEPS}) steps, on the cap's own issue`, () => {
    const r = scenarioStackSchema.safeParse({
      steps: [
        { kind: 'lose_hosts', count: 1 },
        { kind: 'add_vms', count: 1, sizeGb: 1 },
        { kind: 'delay_procurement', months: 1 },
        { kind: 'lose_hosts', count: 2 },
      ],
    });
    expect(r.success).toBe(false);
    expect(
      r.error?.issues.some((issue) => issue.code === 'too_big'),
      'the array-length cap must be the (or a) reason, not just the uniqueness refine',
    ).toBe(true);
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

  /**
   * Steps are `strictObject` too, not just the container. A stripping `z.object`
   * would accept a step carrying another kind's fields and silently drop them —
   * so a caller meaning "delay 3 months" who picked the wrong `kind` would get a
   * lose-one-host forecast back with a 200 and no hint that half the request
   * vanished. Same reasoning as the ambiguity guard: on this endpoint a
   * well-formed wrong answer is worse than a rejection.
   */
  it("rejects a step carrying a foreign kind's fields instead of dropping them", () => {
    const misdirected = scenarioStackSchema.safeParse({
      steps: [{ kind: 'lose_hosts', count: 1, months: 3 }],
    });
    expect(misdirected.success).toBe(false);

    // …and the same for the bare form, which shares these schemas.
    expect(
      scenarioRequestSchema.safeParse({ kind: 'lose_hosts', count: 1, months: 3 }).success,
    ).toBe(false);
    expect(
      scenarioRequestSchema.safeParse({ kind: 'add_vms', count: 5, sizeGb: 8, bogus: 'x' }).success,
    ).toBe(false);
  });

  it('still accepts every legitimate step shape, including the optional startMonth', () => {
    expect(
      scenarioStackSchema.safeParse({
        steps: [
          { kind: 'lose_hosts', count: 1 },
          { kind: 'add_vms', count: 5, sizeGb: 8 },
          { kind: 'delay_procurement', months: 2 },
        ],
      }).success,
    ).toBe(true);
    expect(
      scenarioStackSchema.safeParse({
        steps: [{ kind: 'add_vms', count: 5, sizeGb: 8, startMonth: '2026-12' }],
      }).success,
    ).toBe(true);
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

  /**
   * The ambiguity guard. Without it, `scenarioStackSchema` (a `strictObject`)
   * rejects the extra `kind`/`count`, the union falls through to the bare branch,
   * and that branch — stripping `z.object`s — discards `steps` and yields a
   * one-step stack with a 200. A silently narrowed forecast on an endpoint that
   * drives hardware purchasing is the worst available outcome, so it is a 400.
   */
  it('rejects a body carrying BOTH a bare scenario and a steps array', () => {
    const r = scenarioRequestSchema.safeParse({
      kind: 'lose_hosts',
      count: 1,
      steps: [{ kind: 'add_vms', count: 99, sizeGb: 999 }],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => /never both/.test(i.message))).toBe(true);
  });

  it('does not let a bare scenario smuggle a stack past the cap or the uniqueness rule', () => {
    // Every one of these parsed successfully before the guard, silently narrowed
    // to `{ steps: [{ kind: 'lose_hosts', count: 1 }] }`. Prefixing a valid bare
    // scenario made EVERY stack-level rule unreachable, because the whole `steps`
    // key was dropped before any of them ran.
    const bodies: unknown[] = [
      // over the cap
      {
        kind: 'lose_hosts',
        count: 1,
        steps: [
          { kind: 'lose_hosts', count: 1 },
          { kind: 'add_vms', count: 1, sizeGb: 1 },
          { kind: 'delay_procurement', months: 1 },
          { kind: 'lose_hosts', count: 2 },
        ],
      },
      // duplicate kind — the id-collision guard
      {
        kind: 'lose_hosts',
        count: 1,
        steps: [
          { kind: 'add_vms', count: 10, sizeGb: 16 },
          { kind: 'add_vms', count: 10, sizeGb: 16 },
        ],
      },
      // empty, and outright malformed
      { kind: 'lose_hosts', count: 1, steps: [] },
      { kind: 'lose_hosts', count: 1, steps: 'not-an-array' },
    ];
    for (const body of bodies) {
      expect(scenarioRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('still accepts each shape on its own, unambiguously', () => {
    expect(scenarioRequestSchema.safeParse({ kind: 'lose_hosts', count: 1 }).success).toBe(true);
    expect(
      scenarioRequestSchema.safeParse({ steps: [{ kind: 'lose_hosts', count: 1 }] }).success,
    ).toBe(true);
  });
});

/**
 * `ScenarioRequestWire` is the one wire type in this package that is NOT derived
 * via `z.input` — it cannot be, because `scenarioRequestSchema` opens with the
 * ambiguity guard on `z.unknown()`, whose `z.input` is `unknown`. So it is hand
 * written, and nothing in the type system ties it to the schema it describes.
 *
 * These tests are that tie, in both directions:
 *  - TOO NARROW is a compile error — each sample is annotated
 *    `ScenarioRequestWire`, so a shape the endpoint accepts but the type omits
 *    fails `pnpm typecheck`.
 *  - TOO WIDE is a test failure — every sample is parsed, so a shape the type
 *    admits but the schema rejects fails here.
 *
 * @ai-warning If you add an accepted request shape, add it here too. This file is
 * the only thing keeping that type honest.
 */
describe('ScenarioRequestWire matches what scenarioRequestSchema accepts (#323)', () => {
  const samples: ScenarioRequestWire[] = [
    // Bare single scenario — one per kind, since each is a separate union member.
    { kind: 'lose_hosts', count: 2 },
    { kind: 'add_vms', count: 10, sizeGb: 16 },
    { kind: 'add_vms', count: 10, sizeGb: 16, startMonth: '2026-09' },
    { kind: 'delay_procurement', months: 3 },
    // Stack form: minimum, and a full one at the cap.
    { steps: [{ kind: 'lose_hosts', count: 1 }] },
    {
      steps: [
        { kind: 'lose_hosts', count: 1 },
        { kind: 'add_vms', count: 4, sizeGb: 8, startMonth: '2026-10' },
        { kind: 'delay_procurement', months: 6 },
      ],
    },
  ];

  it('every value the type admits actually parses', () => {
    for (const sample of samples) {
      const result = scenarioRequestSchema.safeParse(sample);
      expect(result.success, `ScenarioRequestWire value rejected: ${JSON.stringify(sample)}`).toBe(
        true,
      );
    }
  });

  it('covers both accepted shapes, so the sample set cannot pass by only testing one', () => {
    expect(samples.some((s) => 'kind' in s)).toBe(true);
    expect(samples.some((s) => 'steps' in s)).toBe(true);
  });
});
