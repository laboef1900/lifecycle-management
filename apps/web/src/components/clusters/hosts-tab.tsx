import type { HostResponse } from '@lcm/shared';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRightLeft,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  FolderInput,
  History,
  MoreVertical,
  Pencil,
  Plus,
  PowerOff,
  Replace,
  Scaling,
  Trash2,
} from 'lucide-react';
import { Fragment, useState } from 'react';

import {
  ganttDomain,
  HostLifecycleGanttAxis,
  HostLifecycleGanttRow,
} from '@/components/detail/host-lifecycle-gantt';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api-client';
import { formatGb, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

import { HostEolPill } from './host-eol-pill';
import { HostStateBadge } from './host-state-badge';
import {
  ConfirmCommissioningDialog,
  CreateHostDialog,
  DecommissionHostDialog,
  DeleteHostDialog,
  EditHostDialog,
  HostHistoryDialog,
  HostMoveDialog,
  HostReplaceDialog,
  HostTransitionDialog,
  ResizeHostDialog,
} from './host-dialogs';

interface HostsTabProps {
  clusterId: string;
  /**
   * Whether to show mutation controls (Add host). The parent derives this from
   * the current role; defaults to true so this stays a presentational unit and
   * the server remains the real enforcement point.
   */
  canManage?: boolean;
}

type DialogKind =
  'edit' | 'resize' | 'decommission' | 'delete' | 'transition' | 'replace' | 'history' | 'move';

export function HostsTab({ clusterId, canManage = true }: HostsTabProps): React.JSX.Element {
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
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
  // Synced hosts vCenter could not date carry a provisional commissioning date
  // (Q9c, #194). Until an admin confirms them the cluster is forecasting from a
  // guess, so surface them as an actionable, non-colour-only banner + CTA.
  const provisionalHosts = hosts.filter((host) => host.commissionedAtProvisional === true);
  // Shared time axis (spec §5.6) for every host's lifecycle bar, computed once
  // so bars stay proportionally aligned across rows.
  const domain = hosts.length > 0 ? ganttDomain(hosts) : null;

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
          {/* Only shown once the table has rows — with no hosts yet the
              EmptyState below carries the one "Add host" CTA (#243 Part B) so
              the two controls never coexist with the same accessible name. */}
          {canManage && hosts.length > 0 ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Add host
            </Button>
          ) : null}
        </header>

        {canManage && provisionalHosts.length > 0 ? (
          <ProvisionalBanner
            count={provisionalHosts.length}
            onConfirm={() => setConfirmOpen(true)}
          />
        ) : null}

        {hostsQuery.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : hostsQuery.isError ? (
          <ErrorRow message={hostsQuery.error.message} />
        ) : hosts.length === 0 ? (
          <EmptyState
            title="Add a host to start contributing capacity."
            action={
              canManage ? (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Add host
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className={domain ? 'border-b-0 hover:bg-transparent' : undefined}>
                <TableHead className="w-8" />
                <TableHead>Name</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="min-w-[230px]">Lifecycle</TableHead>
                <TableHead className="text-right">Current capacity</TableHead>
                {/* Sticky at phone width (#243 Part B): the wide Lifecycle
                    gantt column pushes Actions off-canvas with no scroll cue
                    otherwise — pinning it keeps Edit/More reachable without
                    scrolling. */}
                <TableHead sticky className="w-24 text-right">
                  Actions
                </TableHead>
              </TableRow>
              {domain ? (
                <TableRow className="hover:bg-transparent">
                  <TableHead colSpan={3} />
                  <TableHead className="py-0">
                    <HostLifecycleGanttAxis domain={domain} />
                  </TableHead>
                  <TableHead colSpan={2} />
                </TableRow>
              ) : null}
            </TableHeader>
            <TableBody>
              {hosts.map((host) => {
                const latest = host.capacities[host.capacities.length - 1];
                const isOpen = expanded.has(host.id);
                return (
                  <Fragment key={host.id}>
                    {/* `group` backs the sticky Actions cell's hover match
                        below — the cell itself paints transparent otherwise,
                        so it needs the row's hover state relayed to it. */}
                    <TableRow className="group">
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => toggle(host.id)}
                          className="rounded p-1 text-muted-foreground hover:bg-card-hover hover:text-foreground"
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
                      <TableCell className="min-w-[230px] py-1">
                        {domain ? <HostLifecycleGanttRow host={host} domain={domain} /> : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {latest ? formatGb(latest.amount) : '—'}
                      </TableCell>
                      <TableCell sticky>
                        <RowActions
                          onEdit={() => setTarget({ host, kind: 'edit' })}
                          onResize={() => setTarget({ host, kind: 'resize' })}
                          onDecommission={() => setTarget({ host, kind: 'decommission' })}
                          onTransition={() => setTarget({ host, kind: 'transition' })}
                          onReplace={() => setTarget({ host, kind: 'replace' })}
                          onHistory={() => setTarget({ host, kind: 'history' })}
                          onMove={() => setTarget({ host, kind: 'move' })}
                          onDelete={() => setTarget({ host, kind: 'delete' })}
                          isDecommissioned={Boolean(host.decommissionedAt)}
                          canTransition={host.state !== 'disposed'}
                          canReplace={host.state === 'decommissioned'}
                          // Move is ADMIN-only (#301) and, like the underlying
                          // #289 move endpoint, only ever valid for a MANUAL
                          // host — a synced host's cluster membership is
                          // sync-owned and the server 409s SYNC_OWNED_FIELD.
                          // Both gates are UX affordances only: hiding the
                          // item entirely (not just disabling it) for a
                          // VIEWER, matching the "Add host"/"Add app or
                          // event" pattern elsewhere — the server remains the
                          // real enforcement point either way.
                          canMove={canManage && host.source !== 'vsphere'}
                        />
                      </TableCell>
                    </TableRow>
                    {isOpen ? (
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        <TableCell />
                        <TableCell colSpan={5} className="space-y-3 py-3">
                          <LifecycleDates host={host} />
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

      {confirmOpen ? (
        <ConfirmCommissioningDialog
          open
          onOpenChange={setConfirmOpen}
          clusterId={clusterId}
          hosts={provisionalHosts}
        />
      ) : null}

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
      {target?.kind === 'move' ? (
        <HostMoveDialog
          key={target.host.id}
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
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
  onMove: () => void;
  onDelete: () => void;
  isDecommissioned: boolean;
  canTransition: boolean;
  canReplace: boolean;
  /**
   * Whether "Move…" is offered at all (#301) — combines the ADMIN gate with
   * the manual-host-only gate, both UX affordances only (see the call site).
   * `false` omits the menu item entirely rather than rendering it disabled,
   * so a VIEWER has no path to the mutation from this menu, not just a
   * visually inert one.
   */
  canMove: boolean;
}

/**
 * Row-level actions (#243 Part B): only Edit and Transition — the two most
 * frequent operations — stay inline; everything else folds into the overflow
 * menu behind the MoreVertical kebab, with visible text (not icon-only), so
 * seven equal-weight icon buttons no longer compete for attention. Frequent
 * items (Replace, History, Resize) sit above a separator from the two
 * consequential ones (Decommission, Delete), which the audit groups together
 * as "destructive" — both already require their own confirmation dialog,
 * unchanged here.
 */
function RowActions({
  onEdit,
  onResize,
  onDecommission,
  onTransition,
  onReplace,
  onHistory,
  onMove,
  onDelete,
  isDecommissioned,
  canTransition,
  canReplace,
  canMove,
}: RowActionsProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-end gap-1">
      <IconButton label="Edit" onClick={onEdit}>
        <Pencil className="h-3.5 w-3.5" />
      </IconButton>
      {/* Disabled state is conveyed via aria-disabled, not the native
          `disabled` attribute: a truly disabled button can't take focus, so
          keyboard/AT users could never reach "No further transitions" — the
          one explanation for why the control is inert. Staying focusable
          keeps the focus-triggered tooltip reachable; the guarded onClick
          keeps it inert to activation either way. */}
      <IconButton
        label={canTransition ? 'Transition…' : 'No further transitions'}
        onClick={onTransition}
        disabled={!canTransition}
      >
        <ArrowRightLeft className="h-3.5 w-3.5" />
      </IconButton>
      {/* `modal={false}`: every item here opens a Dialog (setTarget). Radix's
          documented pattern for "open a dialog from a dropdown menu item" —
          left modal (the default), the menu's own focus trap and the
          newly-opened dialog's fight over focus in the same tick, which in
          this app's Radix version pairing (react-dialog's FocusScope vs.
          react-menu's, resolved to different versions) is an infinite loop,
          not just a glitch. Non-modal still returns focus to the trigger
          normally on Escape/outside-click dismissal. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="More actions"
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canReplace ? (
            <DropdownMenuItem onSelect={() => onReplace()}>
              <Replace className="h-4 w-4" />
              Replace…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => onHistory()}>
            <History className="h-4 w-4" />
            View history
          </DropdownMenuItem>
          {/* Scaling, not Plus: Plus already means "add a new host" on the
              header CTA (WCAG SC 3.2.4 consistent identification). */}
          <DropdownMenuItem onSelect={() => onResize()}>
            <Scaling className="h-4 w-4" />
            Resize…
          </DropdownMenuItem>
          {canMove ? (
            <DropdownMenuItem onSelect={() => onMove()}>
              <FolderInput className="h-4 w-4" />
              Move…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          {/* PowerOff, not MoreVertical: the kebab now means "more actions"
              (this trigger) everywhere in the row, so Decommission needed an
              honest glyph of its own. */}
          <DropdownMenuItem onSelect={() => onDecommission()} destructive>
            <PowerOff className="h-4 w-4" />
            {isDecommissioned ? 'Edit decommission' : 'Decommission…'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onDelete()} destructive>
            <Trash2 className="h-4 w-4" />
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function IconButton({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={disabled ? undefined : onClick}
          aria-label={label}
          aria-disabled={disabled ? true : undefined}
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors',
            disabled
              ? 'cursor-not-allowed opacity-40 hover:bg-transparent'
              : 'hover:bg-card-hover hover:text-foreground',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Full lifecycle dates for a host (spec §5.6: "full dates remain in the
 * existing expandable row content" now that the main row shows only the
 * Lifecycle gantt cell).
 */
function LifecycleDates({ host }: { host: HostResponse }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Lifecycle dates
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Commissioned</dt>
          <dd className="tabular-nums">
            {host.commissionedAtProvisional ? (
              <span className="flex flex-wrap items-center gap-1.5">
                {host.commissionedAt}
                <Badge variant="warning" dot>
                  Provisional
                </Badge>
              </span>
            ) : (
              host.commissionedAt
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Decommissioned</dt>
          <dd className="tabular-nums">
            {host.decommissionedAt ? <Badge variant="outline">{host.decommissionedAt}</Badge> : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Warranty</dt>
          <dd className="tabular-nums">{host.warrantyEndsAt ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">EOL</dt>
          <dd className="tabular-nums">{host.eolAt ? <HostEolPill eolAt={host.eolAt} /> : '—'}</dd>
        </div>
      </dl>
    </div>
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
                <span className={cn('text-xs', delta >= 0 ? 'text-success' : 'text-destructive')}>
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

/**
 * Actionable notice that one or more synced hosts still carry a provisional
 * commissioning date (Q9c, #194). Colour is never the sole signal — an icon and
 * explicit text carry the meaning, with a CTA to open the confirm dialog.
 */
function ProvisionalBanner({
  count,
  onConfirm,
}: {
  count: number;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-warning/40 bg-warning/5 p-3">
      <div className="flex items-start gap-2.5">
        <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        <div className="text-sm">
          <p className="font-medium">
            {count === 1
              ? '1 host needs a confirmed commissioning date'
              : `${count} hosts need a confirmed commissioning date`}
          </p>
          <p className="text-fg-muted">
            vCenter could not report when {count === 1 ? 'it was' : 'they were'} commissioned, so
            the forecast is using a provisional date.
          </p>
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onConfirm}>
        <CalendarClock className="h-4 w-4" />
        {count === 1 ? 'Confirm date' : 'Confirm dates'}
      </Button>
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
