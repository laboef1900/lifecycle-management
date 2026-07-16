export { formatMonthLong, formatMonthShort } from '@lcm/shared';

const dayFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** `'2026-09-14'` -> `'Sep 14'` — day-precision date, used for order-by dates. */
export function formatDateShort(dateStr: string): string {
  return dayFormatter.format(new Date(`${dateStr}T00:00:00Z`));
}
