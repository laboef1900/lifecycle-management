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
