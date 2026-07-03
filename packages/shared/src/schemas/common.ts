import { z } from 'zod';

/** Validates a YYYY-MM-DD wire date and transforms it to a UTC midnight Date. */
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date')
  .transform((value) => new Date(`${value}T00:00:00.000Z`));

/** Validates a YYYY-MM wire month and transforms it to a UTC first-of-month Date. */
export const monthOnly = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Must be a YYYY-MM month')
  .transform((value) => new Date(`${value}-01T00:00:00.000Z`));

/** Upper bound keeps values inside Postgres Decimal(18,3)'s 15 integer digits. */
export const MAX_AMOUNT = 1_000_000_000_000;

export const positiveAmount = z
  .number()
  .nonnegative({ message: 'Must be greater than or equal to 0' })
  .finite()
  .max(MAX_AMOUNT);

export const cuid = z.string().min(1);
