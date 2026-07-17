import type { ItemResponse } from '@lcm/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { Fragment, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
import { api } from '@/lib/api-client';
import { formatGb, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

import {
  CreateItemDialog,
  DeleteItemDialog,
  EditItemDialog,
  EndItemDialog,
  ResizeItemDialog,
} from './item-dialogs';

interface ItemsTabProps {
  clusterId: string;
  /**
   * Whether to show mutation controls (Add item). The parent derives this from
   * the current role; defaults to true so this stays a presentational unit and
   * the server remains the real enforcement point.
   */
  canManage?: boolean;
}

type DialogKind = 'edit' | 'resize' | 'end' | 'delete';

/**
 * Maps a category DISPLAY name to a semantic Badge variant, preserving the
 * colour coding the old events tab had per category. Unknown / free-form
 * categories fall back to the neutral `default` variant.
 */
function categoryBadgeVariant(category: string): 'default' | 'outline' | 'success' | 'warning' {
  switch (category) {
    case 'Growth':
      return 'warning';
    case 'Hardware':
      return 'success';
    case 'Note':
      return 'outline';
    case 'OpenShift':
    default:
      return 'default';
  }
}

export function ItemsTab({ clusterId, canManage = true }: ItemsTabProps): React.JSX.Element {
  const [createOpen, setCreateOpen] = useState(false);
  const [target, setTarget] = useState<{ item: ItemResponse; kind: DialogKind } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const query = useQuery({
    queryKey: ['items', clusterId],
    queryFn: () => api.items.listByCluster(clusterId, { limit: 500 }),
  });

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const items = [...(query.data?.items ?? [])].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );
  const total = query.data?.total;

  return (
    <div className="space-y-3 py-4">
      <Card className="p-4">
        <header className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Apps &amp; Events</h2>
            <p className="text-sm text-fg-muted">
              {items.length > 0
                ? `${items.length} ${items.length === 1 ? 'item' : 'items'} on the forecast`
                : 'No apps or events yet.'}
            </p>
          </div>
          {canManage ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Add item
            </Button>
          ) : null}
        </header>

        {query.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : query.isError ? (
          <ErrorRow message={query.error.message} />
        ) : items.length === 0 ? (
          <EmptyState title="Add an application to track its memory allocation, or an event to annotate the forecast." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead className="w-28">Date</TableHead>
                <TableHead className="w-28">Type</TableHead>
                <TableHead className="w-32">Category</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Amount / Δ</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const isApp = item.kind === 'application';
                const isOpen = expanded.has(item.id);
                return (
                  <Fragment key={item.id}>
                    <TableRow>
                      <TableCell>
                        {isApp ? (
                          <button
                            type="button"
                            onClick={() => toggle(item.id)}
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
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground tabular-nums">
                        {item.effectiveDate}
                      </TableCell>
                      <TableCell>
                        <Badge variant={isApp ? 'accent' : 'outline'}>
                          {isApp ? 'Application' : 'Event'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={categoryBadgeVariant(item.category)}>{item.category}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{item.name}</div>
                        {item.description ? (
                          <div className="text-xs text-muted-foreground">{item.description}</div>
                        ) : null}
                        {isApp && item.endedAt ? (
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            Ended {item.endedAt}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {isApp ? <AppAmount item={item} /> : <EventDeltas item={item} />}
                      </TableCell>
                      <TableCell>
                        {isApp ? (
                          <AppRowActions
                            onEdit={() => setTarget({ item, kind: 'edit' })}
                            onResize={() => setTarget({ item, kind: 'resize' })}
                            onEnd={() => setTarget({ item, kind: 'end' })}
                            onDelete={() => setTarget({ item, kind: 'delete' })}
                            isEnded={Boolean(item.endedAt)}
                          />
                        ) : (
                          <EventRowActions
                            onEdit={() => setTarget({ item, kind: 'edit' })}
                            onDelete={() => setTarget({ item, kind: 'delete' })}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                    {isApp && isOpen ? (
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        <TableCell />
                        <TableCell colSpan={6} className="py-3">
                          <AllocationTimeline rows={item.allocations} />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
        {total !== undefined && total > items.length ? (
          <p className="mt-2 text-xs text-fg-subtle" role="status">
            Showing first {items.length} of {total} items.
          </p>
        ) : null}
      </Card>

      <CreateItemDialog open={createOpen} onOpenChange={setCreateOpen} clusterId={clusterId} />

      {target?.kind === 'edit' ? (
        <EditItemDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          item={target.item}
        />
      ) : null}
      {target?.kind === 'resize' ? (
        <ResizeItemDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          item={target.item}
        />
      ) : null}
      {target?.kind === 'end' ? (
        <EndItemDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          item={target.item}
        />
      ) : null}
      {target?.kind === 'delete' ? (
        <DeleteItemDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          item={target.item}
        />
      ) : null}
    </div>
  );
}

function AppAmount({ item }: { item: ItemResponse }): React.JSX.Element {
  const latest = item.allocations[item.allocations.length - 1];
  return <span>{latest ? formatGb(latest.amount) : '—'}</span>;
}

function EventDeltas({ item }: { item: ItemResponse }): React.JSX.Element {
  const { consumptionDelta, capacityDelta } = item;
  if (consumptionDelta === null && capacityDelta === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-col items-end gap-0.5 text-sm">
      {consumptionDelta !== null ? (
        <span className={cn(consumptionDelta >= 0 ? 'text-foreground' : 'text-destructive')}>
          {consumptionDelta >= 0 ? '+' : ''}
          {formatNumber(consumptionDelta)} GB cons
        </span>
      ) : null}
      {capacityDelta !== null ? (
        <span className={cn(capacityDelta >= 0 ? 'text-foreground' : 'text-destructive')}>
          {capacityDelta >= 0 ? '+' : ''}
          {formatNumber(capacityDelta)} GB cap
        </span>
      ) : null}
    </div>
  );
}

interface AppRowActionsProps {
  onEdit: () => void;
  onResize: () => void;
  onEnd: () => void;
  onDelete: () => void;
  isEnded: boolean;
}

function AppRowActions({
  onEdit,
  onResize,
  onEnd,
  onDelete,
  isEnded,
}: AppRowActionsProps): React.JSX.Element {
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

function EventRowActions({
  onEdit,
  onDelete,
}: {
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-end gap-1">
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

function AllocationTimeline({ rows }: { rows: ItemResponse['allocations'] }): React.JSX.Element {
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

function ErrorRow({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="rounded-[var(--radius)] border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      {message}
    </div>
  );
}
