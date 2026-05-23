import type { ApplicationResponse } from '@lcm/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { Fragment, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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

import {
  CreateApplicationDialog,
  DeleteApplicationDialog,
  EditApplicationDialog,
  EndApplicationDialog,
  ResizeApplicationDialog,
} from './application-dialogs';

interface ApplicationsTabProps {
  clusterId: string;
}

type DialogKind = 'edit' | 'resize' | 'end' | 'delete';

export function ApplicationsTab({ clusterId }: ApplicationsTabProps): React.JSX.Element {
  const [createOpen, setCreateOpen] = useState(false);
  const [target, setTarget] = useState<{
    application: ApplicationResponse;
    kind: DialogKind;
  } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const query = useQuery({
    queryKey: ['applications', clusterId],
    queryFn: () => api.applications.listByCluster(clusterId),
  });

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const apps = query.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {apps.length > 0
            ? `${apps.length} ${apps.length === 1 ? 'application' : 'applications'} consuming capacity`
            : 'No applications yet.'}
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Add application
        </Button>
      </div>

      {query.isPending ? (
        <Skeleton />
      ) : query.isError ? (
        <ErrorRow message={query.error.message} />
      ) : apps.length === 0 ? (
        <EmptyRow message="Add an application to track its memory allocation." />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Ended</TableHead>
                <TableHead className="text-right">Current allocation</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((application) => {
                const latest = application.allocations[application.allocations.length - 1];
                const isOpen = expanded.has(application.id);
                return (
                  <Fragment key={application.id}>
                    <TableRow>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => toggle(application.id)}
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
                        <div>{application.name}</div>
                        {application.description ? (
                          <div className="text-xs text-muted-foreground">
                            {application.description}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{application.category}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {application.startedAt}
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {application.endedAt ? (
                          <Badge variant="outline">{application.endedAt}</Badge>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {latest ? formatGb(latest.amount) : '—'}
                      </TableCell>
                      <TableCell>
                        <RowActions
                          onEdit={() => setTarget({ application, kind: 'edit' })}
                          onResize={() => setTarget({ application, kind: 'resize' })}
                          onEnd={() => setTarget({ application, kind: 'end' })}
                          onDelete={() => setTarget({ application, kind: 'delete' })}
                          isEnded={Boolean(application.endedAt)}
                        />
                      </TableCell>
                    </TableRow>
                    {isOpen ? (
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        <TableCell />
                        <TableCell colSpan={6} className="py-3">
                          <AllocationTimeline rows={application.allocations} />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateApplicationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        clusterId={clusterId}
      />

      {target?.kind === 'edit' ? (
        <EditApplicationDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          application={target.application}
        />
      ) : null}
      {target?.kind === 'resize' ? (
        <ResizeApplicationDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          application={target.application}
        />
      ) : null}
      {target?.kind === 'end' ? (
        <EndApplicationDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          application={target.application}
        />
      ) : null}
      {target?.kind === 'delete' ? (
        <DeleteApplicationDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          application={target.application}
        />
      ) : null}
    </div>
  );
}

interface RowActionsProps {
  onEdit: () => void;
  onResize: () => void;
  onEnd: () => void;
  onDelete: () => void;
  isEnded: boolean;
}

function RowActions({
  onEdit,
  onResize,
  onEnd,
  onDelete,
  isEnded,
}: RowActionsProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-end gap-1">
      <IconButton onClick={onResize} title="Resize">
        <Plus className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton onClick={onEnd} title={isEnded ? 'Edit end date' : 'End'}>
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
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  destructive?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded transition-colors',
        destructive
          ? 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function AllocationTimeline({
  rows,
}: {
  rows: ApplicationResponse['allocations'];
}): React.JSX.Element {
  const sorted = [...rows].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Allocation timeline
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
    <div className="rounded-lg border bg-card p-4">
      <div className="space-y-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded bg-muted/60" />
        ))}
      </div>
    </div>
  );
}

function EmptyRow({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function ErrorRow({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      {message}
    </div>
  );
}
