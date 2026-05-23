import { z } from 'zod';

import { cuid } from './common.js';

const monthOnly = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Must be a YYYY-MM month')
  .transform((value) => new Date(`${value}-01T00:00:00.000Z`));

export const forecastParamsSchema = z.object({ id: cuid });

export const forecastQuerySchema = z.object({
  metric: z.string().min(1),
  from: monthOnly.optional(),
  to: monthOnly.optional(),
});

export type ForecastQuery = z.infer<typeof forecastQuerySchema>;
