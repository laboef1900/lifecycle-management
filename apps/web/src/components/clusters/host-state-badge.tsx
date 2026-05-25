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
  ordered: 'bg-blue-100 text-blue-800',
  racked: 'bg-blue-100 text-blue-800',
  in_service: 'bg-emerald-100 text-emerald-800',
  degraded: 'bg-amber-100 text-amber-800',
  decommissioned: 'bg-zinc-100 text-zinc-700',
  disposed: 'bg-neutral-100 text-neutral-600',
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
