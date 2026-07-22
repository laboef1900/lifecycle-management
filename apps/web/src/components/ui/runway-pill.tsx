import { SYSTEM_DEFAULTS } from '@lcm/shared';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { formatRunway } from '@/lib/format';

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

/** Semantic tone a runway summary maps to — shared between this Badge's
 *  variant and the KPI-strip Runway tile's `KpiTile` status accent (#243 Part
 *  B item 2), so the warn/crit thresholds are decided in exactly one place. */
export type RunwayTone = 'unknown' | 'crit' | 'warn' | 'ok';

/**
 * The one place the warn/crit/no-breach thresholds are decided for a runway
 * summary. `RunwayPill` below and `ClusterDetailKpiStrip`'s Runway tile
 * (`detail/cluster-panel.tsx`) both call this rather than each re-deriving
 * the same `< 3` / `< 12` cutoffs, which is exactly how the KPI strip's tile
 * and the dense-table pill drifted apart before (#243 Part B item 2).
 */
export function deriveRunwayTone(summary: RunwaySummary | undefined, unknown: boolean): RunwayTone {
  if (unknown || !summary) return 'unknown';
  if (summary.alreadyBreached === 'crit') return 'crit';
  if (summary.alreadyBreached === 'warn') return 'warn';
  if (summary.months === null) return 'ok';
  return summary.months < 3 ? 'crit' : summary.months < 12 ? 'warn' : 'ok';
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
            ? formatRunway(horizonMonths, true)
            : 'No breach in horizon'}
        </span>
      </Badge>
    );
  }
  const tone = deriveRunwayTone(summary, false);
  const variant = tone === 'crit' ? 'danger' : tone === 'warn' ? 'warning' : 'accent';
  return (
    <Badge variant={variant}>
      <span>{`${formatRunway(summary.months)} to ${warnPct}%`}</span>
    </Badge>
  );
}
