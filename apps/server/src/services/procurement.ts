import type { ProcurementInfo } from '@lcm/shared';

import { formatDate } from '../lib/dates.js';
import type { MonthlyPoint } from './forecast.js';

interface OrderByInput {
  months: MonthlyPoint[];
  warnFraction: number;
  leadTimeWeeks: number;
}

/**
 * Convert runway + lead time into a procurement deadline.
 *
 * Finds the first month at or above warn, then subtracts leadTimeWeeks*7 days
 * from the first day of that month. Returns null breachMonth/orderByDate when
 * the forecast window contains no breach.
 *
 * Past dates are returned as-is so the UI can surface "overdue" rather than
 * hiding the problem. leadTimeWeeks === 0 collapses orderByDate onto the
 * breach month's first day.
 */
export function computeProcurementInfo({
  months,
  warnFraction,
  leadTimeWeeks,
}: OrderByInput): ProcurementInfo {
  // `capacity > 0` already implies `utilization !== null` (null means capacity is
  // exactly 0), so the null check is a type guard, not new behaviour — and both
  // are kept deliberately. `capacity > 0` additionally excludes NEGATIVE capacity,
  // which events can produce; dropping it for the null check alone would quietly
  // change which months can breach.
  const breach = months.find(
    (m) => m.capacity > 0 && m.utilization !== null && m.utilization >= warnFraction,
  );
  if (!breach) {
    return { leadTimeWeeks, orderByDate: null, breachMonth: null };
  }
  const breachDate = new Date(`${breach.month}T00:00:00Z`);
  const orderBy = new Date(breachDate.getTime() - leadTimeWeeks * 7 * 24 * 60 * 60 * 1000);
  return {
    leadTimeWeeks,
    orderByDate: formatDate(orderBy),
    breachMonth: breach.month,
  };
}
