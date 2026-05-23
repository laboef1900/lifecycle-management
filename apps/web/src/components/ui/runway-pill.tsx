import * as React from 'react';

import { Badge } from '@/components/ui/badge';

import type { RunwaySummary } from '@/lib/forecast-summary';

interface RunwayPillProps {
  summary: RunwaySummary | undefined;
  /** Forecast horizon length in months, used to display "N+ mo" when no breach. */
  horizonMonths?: number;
}

export function RunwayPill({ summary, horizonMonths }: RunwayPillProps): React.JSX.Element {
  if (!summary) {
    return (
      <Badge variant="outline">
        <span>—</span>
      </Badge>
    );
  }
  if (summary.alreadyBreached === 'crit') {
    return (
      <Badge variant="danger">
        <span>Over 90%</span>
      </Badge>
    );
  }
  if (summary.alreadyBreached === 'warn') {
    return (
      <Badge variant="warning">
        <span>Over 70%</span>
      </Badge>
    );
  }
  if (summary.months === null) {
    return (
      <Badge variant="success">
        <span>
          {horizonMonths !== undefined && horizonMonths > 0
            ? `${horizonMonths}+ mo`
            : 'No breach in horizon'}
        </span>
      </Badge>
    );
  }
  const variant = summary.months < 3 ? 'danger' : summary.months < 12 ? 'warning' : 'success';
  return (
    <Badge variant={variant}>
      <span>{`${summary.months} mo to 70%`}</span>
    </Badge>
  );
}
