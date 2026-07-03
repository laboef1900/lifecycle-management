import type { HostResponse } from '@lcm/shared';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  History,
  MoreVertical,
  Pencil,
  Plus,
  Replace,
  Trash2,
} from 'lucide-react';
import { Fragment, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { formatGb, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

import { HostEolPill } from './host-eol-pill';
import { HostStateBadge } from './host-state-badge';
import {
  CreateHostDialog,
  DecommissionHostDialog,
  DeleteHostDialog,
  EditHostDialog,
  HostHistoryDialog,
  HostReplaceDialog,
  HostTransitionDialog,
  ResizeHostDialog,
} from './host-dialogs';

interface HostsTabProps {
  clusterId: string;
}

type DialogKind =
  'edit' | 'resize' | 'decommission' | 'delete' | 'transition' | 'replace' | 'history';

export function HostsTab({ clusterId }: HostsTabProps): React.JSX.Element {
  const [createOpen, setCreateOpen] = useState(false);
  const [target, setTarget] = useState<{ host: HostResponse; kind: DialogKind } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const hostsQuery = useQuery({
    queryKey: ['hosts', clusterId],
    queryFn: () => api.hosts.listByCluster(clusterId, { limit: 500 }),
  });

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const hosts = hostsQuery.data?.items ?? [];
  const total = hostsQuery.data?.total;

  return (
    <div className="space-y-3 py-4">
      <Card className="p-4">
        <header className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Hosts</h2>
            <p className="text-sm text-fg-muted">
              {hosts.length > 0
                ? `${hosts.length} ${hosts.length === 1 ? 'host' : 'hosts'} providing capacity`
                : 'No hosts yet.'}
            </p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Add host
          </Button>
        </header>

        {hostsQuery.isPending ? (
          <Skeleton />
        ) : hostsQuery.isError ? (
          <ErrorRow message={hostsQuery.error.message} />
        ) : hosts.length === 0 ? (
          <EmptyRow message="Add a host to start contributing capacity." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Name</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Commissioned</TableHead>
                <TableHead>Decommissioned</TableHead>
                <TableHead>Warranty</TableHead>
                <TableHead>EOL</TableHead>
                <TableHead className="text-right">Current capacity</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hosts.map((host) => {
                const latest = host.capacities[host.capacities.length - 1];
                const isOpen = expanded.has(host.id);
                return (
                  <Fragment key={host.id}>
                    <TableRow>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => toggle(host.id)}
                          className="rounded p-1 hover:bg-accent"
                          aria-expanded={isOpen}
                          aria-label={isOpen ? 'Collapse history' : 'Expand history'}
                        >
                          {isOpen ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                      </TableCell>
                      <TableCell className="font-medium">
                        <div>{host.name}</div>
                        {host.description ? (
                          <div className="text-xs text-muted-foreground">{host.description}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <HostStateBadge state={host.state} />
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {host.commissionedAt}
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {host.decommissionedAt ? (
                          <Badge variant="outline">{host.decommissionedAt}</Badge>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {host.warrantyEndsAt ?? '—'}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {host.eolAt ? <HostEolPill eolAt={host.eolAt} /> : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {latest ? formatGb(latest.amount) : '—'}
                      </TableCell>
                      <TableCell>
                        <RowActions
                          onEdit={() => setTarget({ host, kind: 'edit' })}
                          onResize={() => setTarget({ host, kind: 'resize' })}
                          onDecommission={() => setTarget({ host, kind: 'decommission' })}
                          onTransition={() => setTarget({ host, kind: 'transition' })}
                          onReplace={() => setTarget({ host, kind: 'replace' })}
                          onHistory={() => setTarget({ host, kind: 'history' })}
                          onDelete={() => setTarget({ host, kind: 'delete' })}
                          isDecommissioned={Boolean(host.decommissionedAt)}
                          canTransition={host.state !== 'disposed'}
                          canReplace={host.state === 'decommissioned'}
                        />
                      </TableCell>
                    </TableRow>
                    {isOpen ? (
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        <TableCell />
                        <TableCell colSpan={8} className="py-3">
                          <CapacityTimeline rows={host.capacities} />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
        {total !== undefined && total > hosts.length ? (
          <p className="mt-2 text-xs text-fg-subtle" role="status">
            Showing first {hosts.length} of {total} hosts.
          </p>
        ) : null}
      </Card>

      <CreateHostDialog open={createOpen} onOpenChange={setCreateOpen} clusterId={clusterId} />

      {target?.kind === 'edit' ? (
        <EditHostDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          host={target.host}
        />
      ) : null}
      {target?.kind === 'resize' ? (
        <ResizeHostDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          host={target.host}
        />
      ) : null}
      {target?.kind === 'decommission' ? (
        <DecommissionHostDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          host={target.host}
        />
      ) : null}
      {target?.kind === 'delete' ? (
        <DeleteHostDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          host={target.host}
        />
      ) : null}
      {target?.kind === 'transition' ? (
        <HostTransitionDialog
          key={target.host.id}
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          host={target.host}
        />
      ) : null}
      {target?.kind === 'replace' ? (
        <HostReplaceDialog
          key={target.host.id}
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          host={target.host}
          candidates={hosts}
        />
      ) : null}
      {target?.kind === 'history' ? (
        <HostHistoryDialog
          key={target.host.id}
          open
          onOpenChange={(open) => !open && setTarget(null)}
          host={target.host}
        />
      ) : null}
    </div>
  );
}

interface RowActionsProps {
  onEdit: () => void;
  onResize: () => void;
  onDecommission: () => void;
  onTransition: () => void;
  onReplace: () => void;
  onHistory: () => void;
  onDelete: () => void;
  isDecommissioned: boolean;
  canTransition: boolean;
  canReplace: boolean;
}

function RowActions({
  onEdit,
  onResize,
  onDecommission,
  onTransition,
  onReplace,
  onHistory,
  onDelete,
  isDecommissioned,
  canTransition,
  canReplace,
}: RowActionsProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-end gap-1">
      <IconButton
        onClick={onTransition}
        title={canTransition ? 'Transition…' : 'No further transitions'}
        disabled={!canTransition}
      >
        <ArrowRightLeft className="h-3.5 w-3.5" />
      </IconButton>
      {canReplace ? (
        <IconButton onClick={onReplace} title="Replace…">
          <Replace className="h-3.5 w-3.5" />
        </IconButton>
      ) : null}
      <IconButton onClick={onHistory} title="View history">
        <History className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton onClick={onResize} title="Resize">
        <Plus className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        onClick={onDecommission}
        title={isDecommissioned ? 'Edit decommission' : 'Decommission'}
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton onClick={onEdit} title="Edit">
        <Pencil className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton onClick={onDelete} title="Delete" destructive>
        <Trash2 className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
}

function IconButton({
  children,
  title,
  destructive,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
        destructive
          ? 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function CapacityTimeline({ rows }: { rows: HostResponse['capacities'] }): React.JSX.Element {
  const sorted = [...rows].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Capacity timeline
      </p>
      <ol className="space-y-1 text-sm">
        {sorted.map((row, index) => {
          const prev = index > 0 ? sorted[index - 1] : undefined;
          const delta = prev ? row.amount - prev.amount : null;
          return (
            <li key={row.id} className="flex items-center gap-3 tabular-nums">
              <span className="font-mono text-xs text-muted-foreground">{row.effectiveFrom}</span>
              <span>{formatGb(row.amount)}</span>
              {delta !== null ? (
                <span
                  className={cn('text-xs', delta >= 0 ? 'text-emerald-700' : 'text-destructive')}
                >
                  {delta >= 0 ? '+' : ''}
                  {formatNumber(delta)} GB
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Skeleton(): React.JSX.Element {
  return (
    <div className="space-y-2">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="h-12 animate-pulse rounded bg-muted/60" />
      ))}
    </div>
  );
}

function EmptyRow({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="rounded-[var(--radius)] border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function ErrorRow({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="rounded-[var(--radius)] border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      {message}
    </div>
  );
}
