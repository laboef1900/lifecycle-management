import type { HostState } from '@lcm/shared';

// ALL-CAPS (#243 Part B copy item 2): every other status-class badge in the
// app (cluster-tile.tsx's OK/WARN/CRIT, recommendation-chip.tsx's ORDER NOW/
// PLANNED, FlagChip's BASELINE/EVENT chips) is ALL-CAPS — this was the one
// sentence-case outlier ("In service").
const LABELS: Record<HostState, string> = {
  ordered: 'ORDERED',
  racked: 'RACKED',
  in_service: 'IN SERVICE',
  degraded: 'DEGRADED',
  decommissioned: 'DECOMMISSIONED',
  disposed: 'DISPOSED',
};

const COLORS: Record<HostState, string> = {
  ordered: 'text-[var(--steel)] bg-[color-mix(in_oklab,var(--steel)_12%,transparent)]',
  racked: 'text-[var(--steel)] bg-[color-mix(in_oklab,var(--steel)_12%,transparent)]',
  in_service: 'text-success bg-success/10',
  degraded: 'text-warning bg-warning/10',
  decommissioned: 'text-muted-foreground bg-muted',
  disposed: 'text-muted-foreground bg-muted',
};

export function HostStateBadge({ state }: { state: HostState }): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${COLORS[state]}`}
    >
      {LABELS[state]}
    </span>
  );
}
