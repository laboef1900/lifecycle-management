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
  utilization: number;
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

export interface ForecastResponse {
  fromMonth: string;
  toMonth: string;
  months: ForecastMonthPoint[];
  events: ForecastEventMarker[];
  hosts: ForecastEntityContribution[];
  applications: ForecastEntityContribution[];
  effectiveThresholds: EffectiveThresholds;
  procurement: ProcurementInfo;
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
