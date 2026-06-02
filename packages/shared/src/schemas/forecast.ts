import { z } from 'zod';

import { cuid, monthOnly } from './common.js';
import type { EffectiveThresholds } from './settings.js';

export const forecastParamsSchema = z.object({ id: cuid });

export const forecastQuerySchema = z.object({
  metric: z.string().min(1),
  from: monthOnly.optional(),
  to: monthOnly.optional(),
});

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
