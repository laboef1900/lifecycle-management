import { z } from 'zod';

import { monthsBetweenUtc } from '../dates.js';
import { cuid, monthOnly } from './common.js';
import type { EffectiveThresholds } from './settings.js';

export const forecastParamsSchema = z.object({ id: cuid });

/** Hard cap on the forecast window — protects the O(months × rows) compute loop. */
export const MAX_FORECAST_SPAN_MONTHS = 120;

export const forecastQuerySchema = z
  .object({
    metric: z.string().min(1),
    from: monthOnly.optional(),
    to: monthOnly.optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'from must be on or before to',
    path: ['from'],
  })
  .refine(
    (q) =>
      q.from === undefined ||
      q.to === undefined ||
      monthsBetweenUtc(q.from, q.to) <= MAX_FORECAST_SPAN_MONTHS,
    { message: `Range must not exceed ${MAX_FORECAST_SPAN_MONTHS} months`, path: ['to'] },
  );

export type ForecastQuery = z.infer<typeof forecastQuerySchema>;

export interface ForecastMonthPoint {
  month: string;
  consumption: number;
  capacity: number;
  /**
   * Fraction of capacity consumed, or **null when capacity is 0** — i.e. when
   * utilization is not merely low but *unknowable*.
   *
   * @ai-warning Do NOT default this to 0. Zero capacity previously rendered as
   * "0% utilised", which reads as *maximum headroom, healthy* — the single most
   * dangerous wrong answer a capacity tool can give, since it is the state in
   * which no hardware gets ordered. `null` forces every consumer to decide what
   * "unknown" looks like instead of inheriting a reassuring lie. Recorded
   * decision Q9d, 2026-07-17.
   */
  utilization: number | null;
}

/**
 * One point in a cluster/metric's append-only baseline history (#177).
 *
 * `capturedAt` is the period anchor (first of the month), not the instant of
 * measurement — see `ClusterBaselineHistory` in schema.prisma.
 */
export interface BaselineHistoryPoint {
  capturedAt: string;
  source: 'manual' | 'vsphere';
  consumption: number;
  capacity: number;
  /** Fraction consumed at capture time; null when the captured capacity was 0. */
  utilization: number | null;
}

export interface ForecastEventMarker {
  id: string;
  effectiveDate: string;
  category: string;
  title: string;
  description: string | null;
  consumptionDelta: number | null;
  capacityDelta: number | null;
}

export interface ForecastEntityContribution {
  id: string;
  name: string;
  projectedDecommissionAt?: string | null;
  contributions: Array<{ month: string; amount: number }>;
}

export interface ProcurementInfo {
  leadTimeWeeks: number;
  /** null when no projected warn breach in the forecast window. */
  orderByDate: string | null;
  /** First month at or above warn; null when no breach. */
  breachMonth: string | null;
}

/**
 * Annotation-only acknowledgment of the live procurement recommendation (#292).
 * Present when the cluster's latest `OrderApproval` still covers the live breach
 * (DESIGN.md §3 coverage rule); `null` when there is no breach or the approval
 * has been superseded (capacity/threshold changed, or the breach worsened by
 * ≥ T). Purely descriptive — it never feeds back into the forecast math (INV-1).
 */
export interface ForecastAcknowledgment {
  /** Free-text note captured at approval time; `null` when the admin left it blank. */
  note: string | null;
  /** Who approved: a username/e-mail, or "anonymous (auth disabled)". */
  approvedByLabel: string;
  /** ISO instant the approval was recorded. */
  approvedAt: string;
}

/**
 * One projected month's empirical uncertainty band, derived from measured past
 * forecast error (docs/design/forecast-uncertainty-band.md). Bounds are in the
 * SAME unit as {@link ForecastMonthPoint.utilization} (fraction of capacity), so
 * a renderer reads them off the same axis with no conversion. Raw bounds may
 * fall below 0 or above 1 — renderers clamp for display; the stored math is not
 * clamped so the spread stays honest.
 */
export interface ForecastUncertaintyPoint {
  month: string;
  low: number;
  high: number;
  /**
   * How many matured past forecasts were measured AT THIS MONTH'S HORIZON — the
   * evidence behind *this* point, not the chart (#317).
   *
   * @ai-warning This is NOT {@link ForecastResponse.uncertaintyAnchorCount} and is
   * usually much smaller. That counts distinct anchor months across the whole
   * band; this counts the samples at one horizon index. An anchor contributes at
   * most one sample per horizon, so `sampleCount <= uncertaintyAnchorCount`
   * always — and the far end of the band typically sits near the engine's
   * per-horizon floor while the near end has many more. Quoting the global count
   * next to a far-out month overstates its evidence, which is exactly what this
   * field exists to prevent.
   *
   * Additive/optional so a server build predating #317 still parses; when
   * present it is `>= PER_HORIZON_MIN_SAMPLES` (a horizon below the floor draws
   * no band at all, so a count the UI can render is never misleadingly tiny).
   */
  sampleCount?: number;
}

export interface ForecastResponse {
  fromMonth: string;
  toMonth: string;
  months: ForecastMonthPoint[];
  events: ForecastEventMarker[];
  hosts: ForecastEntityContribution[];
  applications: ForecastEntityContribution[];
  effectiveThresholds: EffectiveThresholds;
  procurement: ProcurementInfo;
  /**
   * Every recorded baseline for this cluster/metric, oldest first — the measured
   * actuals behind the modelled line. The forecast anchors on the LAST entry.
   *
   * A month absent from this series is an honest gap (a snapshot that could not
   * be taken), never a zero. Renderers MUST break the line rather than
   * interpolate across it: silently joining July to September turns a missed
   * measurement into a fabricated trend, on the series that drives purchasing.
   */
  baselineHistory: BaselineHistoryPoint[];
  /**
   * The acknowledgment covering the live breach, or `null`. Additive/optional so
   * an older server that omits it still satisfies the contract (#292); the
   * current server always sets it (to an object or `null`).
   */
  acknowledgment?: ForecastAcknowledgment | null;
  /**
   * Empirical uncertainty band over the FUTURE (projected) months. Present only
   * when the tenant setting is enabled AND enough matured re-anchors exist —
   * omitted otherwise (honest absence, never a fabricated zero-width band).
   * Additive/optional (an older server simply omits it). A scenario response
   * never carries a band: a hypothetical has no measured error history (INV-1).
   */
  uncertainty?: ForecastUncertaintyPoint[];
  /**
   * How many distinct past re-anchors the band was measured from, across ALL
   * horizons. Present exactly when `uncertainty` is; ≥ the configured
   * minimum-anchors floor.
   *
   * @ai-warning This is the size of the evidence POOL, not the evidence behind
   * any one month of the band — see {@link ForecastUncertaintyPoint.sampleCount}.
   * The two diverge sharply once a snapshot-retention window is configured
   * (#318): the window caps each horizon's sample count at `retentionMonths`,
   * while an anchor up to 24 months older than the window still projects into it,
   * so this count keeps climbing to roughly `retentionMonths + 23`. Do not render
   * it as the number a given month's band rests on.
   */
  uncertaintyAnchorCount?: number;
}

// ---------- What-if scenarios ----------

export const loseHostsScenarioSchema = z.object({
  kind: z.literal('lose_hosts'),
  count: z.number().int().min(1),
});

export const addVmsScenarioSchema = z.object({
  kind: z.literal('add_vms'),
  count: z.number().int().min(1),
  sizeGb: z.number().positive(),
  startMonth: monthOnly.optional(),
});

export const delayProcurementScenarioSchema = z.object({
  kind: z.literal('delay_procurement'),
  months: z.number().int().min(1),
});

export const scenarioSchema = z.discriminatedUnion('kind', [
  loseHostsScenarioSchema,
  addVmsScenarioSchema,
  delayProcurementScenarioSchema,
]);

export type LoseHostsScenario = z.infer<typeof loseHostsScenarioSchema>;
export type AddVmsScenario = z.infer<typeof addVmsScenarioSchema>;
export type DelayProcurementScenario = z.infer<typeof delayProcurementScenarioSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;

/**
 * Hard cap on a compound what-if (#323) — protects the same O(months × rows)
 * compute loop as {@link MAX_FORECAST_SPAN_MONTHS}.
 *
 * @ai-note This is deliberately a SEPARATE rule from the one-step-per-kind
 * refine below, even though three kinds × "at most once each" already implies
 * three. Add a fourth kind and uniqueness stops bounding the stack; this does
 * not.
 */
export const MAX_SCENARIO_STEPS = 3;

/**
 * The order a compound scenario's steps are applied in — and, because the UI
 * lists its rows the same way, the order they are shown in.
 *
 * Lives here rather than beside the fold because **both** the server and the web
 * app need it: the server sorts by it in `applyScenarioStack`, the rail renders
 * its removable rows by it, and the summary text lists them by it. Two copies
 * would let the rail claim one order while the forecast folds in another.
 *
 * @ai-warning This exhaustive `Record` is the real tripwire for a new scenario
 * kind: adding a member to the `Scenario` union without adding it here is a
 * compile error (TS2741). Its sibling tripwire is `applyScenario`'s switch, which
 * errors with TS2366 — "lacks ending return statement" — because of its explicit
 * return type under `strictNullChecks`. (An earlier comment credited
 * `noFallthroughCasesInSwitch`; that flag only reports a case falling THROUGH to
 * the next one and says nothing about a missing case.) Neither tripwire is a
 * test, and the permutation test in `scenario.test.ts` deliberately cannot catch
 * this — see its `@ai-warning`.
 */
export const SCENARIO_STEP_ORDER: Readonly<Record<Scenario['kind'], number>> = {
  lose_hosts: 0,
  add_vms: 1,
  delay_procurement: 2,
};

/** Sort comparator for {@link SCENARIO_STEP_ORDER}; use on a COPY of the array. */
export const compareScenarioSteps = (a: Scenario['kind'], b: Scenario['kind']): number =>
  SCENARIO_STEP_ORDER[a] - SCENARIO_STEP_ORDER[b];

/**
 * A compound what-if: several scenario steps evaluated as one hypothetical.
 *
 * @ai-warning A kind may appear AT MOST ONCE, and that is a correctness rule
 * rather than a UI convenience. `addSyntheticVms` mints a deterministic
 * application id from `count`/`sizeGb`, and the forecast engine keys its
 * per-application contributions on a `Map<id, …>` — so two `add_vms` steps
 * sharing an id emit two response entries backed by the SAME aliased array,
 * with two amounts per month under one id. Month totals stay correct (the
 * consumption sum iterates the array, not the map), which is exactly why no
 * total-based assertion catches it. Relaxing this refine requires making the
 * synthetic id unique per step first. See
 * `docs/superpowers/specs/2026-07-28-compound-scenario-stack-design.md`.
 */
export const scenarioStackSchema = z
  .strictObject({
    steps: z.array(scenarioSchema).min(1).max(MAX_SCENARIO_STEPS),
  })
  .refine((stack) => new Set(stack.steps.map((s) => s.kind)).size === stack.steps.length, {
    message: 'Each scenario kind may appear at most once',
    path: ['steps'],
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What the preview endpoint accepts: a stack, or a bare single scenario
 * normalised to a one-step stack.
 *
 * @ai-warning Additive on purpose — do NOT collapse this to the stack form
 * alone. `web` and `server` are separately-tagged GHCR images pinned by
 * `LCM_IMAGE_TAG`, so a hard cutover would 400 every preview from an older SPA
 * in a mixed-tag deployment. Same discipline as the additive `acknowledgment`
 * (#292) and `uncertainty` (#316) response fields.
 *
 * @ai-warning The ambiguity guard below is load-bearing, NOT defensive
 * boilerplate. A plain `z.union([stack, bare])` is silently wrong for a body
 * carrying BOTH shapes: `scenarioStackSchema` is a `strictObject` so it rejects
 * the extra `kind`/`count` keys, the union falls through to the bare branch, and
 * that branch — a discriminated union of *stripping* `z.object`s — discards
 * `steps` entirely and answers 200 with a one-step forecast. Every stack-level
 * rule then becomes unreachable too: prefixing a valid bare scenario bypassed
 * the `.max(MAX_SCENARIO_STEPS)` cap AND the duplicate-kind refine that the
 * whole id-collision defence rests on. A silently narrowed forecast is the worst
 * possible failure for an endpoint whose output drives hardware purchasing, so
 * an ambiguous body is a 400 — never a guess about which shape was meant.
 * (Found by AI review of the first implementation; reproduced end to end.)
 */
export const scenarioRequestSchema = z
  .unknown()
  .superRefine((body, ctx) => {
    if (isRecord(body) && 'steps' in body && 'kind' in body) {
      ctx.addIssue({
        code: 'custom',
        message: 'Send either a single scenario or { steps: [...] }, never both',
        path: ['steps'],
      });
    }
  })
  .pipe(
    z.union([scenarioStackSchema, scenarioSchema.transform((scenario) => ({ steps: [scenario] }))]),
  );

export type ScenarioStack = z.infer<typeof scenarioStackSchema>;
export type ScenarioRequest = z.infer<typeof scenarioRequestSchema>;
/** Wire (pre-transform) shapes — `startMonth` is `'YYYY-MM'`, not a `Date`. */
export type ScenarioStackWire = z.input<typeof scenarioStackSchema>;
/**
 * Either accepted body shape. Written out rather than `z.input<typeof
 * scenarioRequestSchema>`, which is `unknown` now that the schema opens with the
 * ambiguity guard.
 */
export type ScenarioRequestWire = ScenarioStackWire | z.input<typeof scenarioSchema>;
