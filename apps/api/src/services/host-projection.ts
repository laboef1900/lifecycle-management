import type { HostState } from '@prisma/client';

interface MinimalReplacement {
  new: { commissionedAt: Date };
}

export interface ProjectableHost {
  state: HostState;
  eolAt: Date | null;
  runPastEol: boolean;
  replacedByLinks: MinimalReplacement[];
}

const ACTIVE: readonly HostState[] = ['in_service', 'degraded'] as const;

export function projectedDecommissionDate(host: ProjectableHost): Date | null {
  if (!host.eolAt || host.runPastEol) return null;
  if (!ACTIVE.includes(host.state)) return null;
  const eol = host.eolAt;
  const covered = host.replacedByLinks.some((r) => r.new.commissionedAt <= eol);
  return covered ? null : eol;
}
