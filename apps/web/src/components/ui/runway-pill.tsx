import { SYSTEM_DEFAULTS } from '@lcm/shared';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';

import type { RunwaySummary } from '@/lib/forecast-summary';

interface RunwayPillProps {
  summary: RunwaySummary | undefined;
  /** Current capacity is missing, so an all-clear runway cannot be calculated. */
  unknown?: boolean;
  /** Forecast horizon length in months, used to display "N+ mo" when no breach. */
  horizonMonths?: number;
  /** Effective warn/crit thresholds. Defaults to system 70/90. */
  thresholds?: { warn: number; crit: number };
}

export function RunwayPill({
  summary,
  unknown = false,
  horizonMonths,
  thresholds = SYSTEM_DEFAULTS,
}: RunwayPillProps): React.JSX.Element {
  if (unknown) {
    return (
      <Badge variant="outline">
        <span>Unknown — no capacity</span>
      </Badge>
    );
  }
  if (!summary) {
    return (
      <Badge variant="outline">
        <span>—</span>
      </Badge>
    );
  }
  const warnPct = Math.round(thresholds.warn * 100);
  const critPct = Math.round(thresholds.crit * 100);
  if (summary.alreadyBreached === 'crit') {
    return (
      <Badge variant="danger">
        <span>{`Over ${critPct}%`}</span>
      </Badge>
    );
  }
  if (summary.alreadyBreached === 'warn') {
    return (
      <Badge variant="warning">
        <span>{`Over ${warnPct}%`}</span>
      </Badge>
    );
  }
  if (summary.months === null) {
    return (
      <Badge variant="accent">
        <span>
          {horizonMonths !== undefined && horizonMonths > 0
            ? `${horizonMonths}+ mo`
            : 'No breach in horizon'}
        </span>
      </Badge>
    );
  }
  const variant = summary.months < 3 ? 'danger' : summary.months < 12 ? 'warning' : 'accent';
  return (
    <Badge variant={variant}>
      <span>{`${summary.months} mo to ${warnPct}%`}</span>
    </Badge>
  );
}
