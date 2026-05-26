import type { ProcurementInfo } from '@lcm/shared';

export type ProcurementKpiStatus = 'ok' | 'attention' | 'warn' | 'crit';

export interface ProcurementKpi {
  value: string;
  caption: string;
  status: ProcurementKpiStatus;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const URGENT_DAYS = 28;

function formatMonthLong(monthStr: string): string {
  return new Date(`${monthStr}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Days from `today` (midnight UTC) until `dateStr` (also midnight UTC). Negative if past. */
function daysUntil(dateStr: string, today: Date): number {
  const target = new Date(`${dateStr}T00:00:00Z`).getTime();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target - todayUtc) / DAY_MS);
}

export function deriveProcurementKpi(
  info: ProcurementInfo,
  today: Date = new Date(),
): ProcurementKpi {
  if (info.breachMonth === null || info.orderByDate === null) {
    return {
      value: '—',
      caption: 'no projected breach in window',
      status: 'ok',
    };
  }

  const days = daysUntil(info.orderByDate, today);
  const breachLabel = formatMonthLong(info.breachMonth);

  if (days < 0) {
    return {
      value: info.orderByDate,
      caption: `overdue — should have ordered for ${breachLabel} warn breach`,
      status: 'crit',
    };
  }

  if (days <= URGENT_DAYS) {
    return {
      value: info.orderByDate,
      caption: `order in ${days} day${days === 1 ? '' : 's'} for ${breachLabel} warn breach`,
      status: 'warn',
    };
  }

  const lead = info.leadTimeWeeks;
  const leadPhrase = lead === 0 ? '' : `${lead}wk lead time `;
  return {
    value: info.orderByDate,
    caption: `${leadPhrase}before ${breachLabel} warn breach`,
    status: 'ok',
  };
}
