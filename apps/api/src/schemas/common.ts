import { z } from 'zod';

export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date')
  .transform((value) => new Date(`${value}T00:00:00.000Z`));

export const positiveAmount = z
  .number()
  .nonnegative({ message: 'Must be greater than or equal to 0' })
  .finite();

export const cuid = z.string().min(1);

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
