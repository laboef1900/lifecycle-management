import type { HostState } from '@lcm/shared';

const LABELS: Record<HostState, string> = {
  ordered: 'Ordered',
  racked: 'Racked',
  in_service: 'In service',
  degraded: 'Degraded',
  decommissioned: 'Decommissioned',
  disposed: 'Disposed',
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
