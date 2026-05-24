import { z } from 'zod';

import { cuid, monthOnly } from './common.js';
import type { EventCategory } from './event.js';
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
  category: EventCategory;
  title: string;
  description: string | null;
  consumptionDelta: number | null;
  capacityDelta: number | null;
}

export interface ForecastEntityContribution {
  id: string;
  name: string;
  contributions: Array<{ month: string; amount: number }>;
}

export interface ForecastResponse {
  fromMonth: string;
  toMonth: string;
  months: ForecastMonthPoint[];
  events: ForecastEventMarker[];
  hosts: ForecastEntityContribution[];
  applications: ForecastEntityContribution[];
  effectiveThresholds: EffectiveThresholds;
}
