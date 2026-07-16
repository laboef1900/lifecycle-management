import type { ProcurementInfo } from '@lcm/shared';

import { daysUntil } from '@/lib/dates';
import { formatMonthLong } from '@/lib/format-month';

export type ProcurementKpiStatus = 'ok' | 'attention' | 'warn' | 'crit';

export interface ProcurementKpi {
  value: string;
  caption: string;
  status: ProcurementKpiStatus;
}

const URGENT_DAYS = 28;

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
