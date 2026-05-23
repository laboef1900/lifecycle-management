import type { EventCategory, EventResponse } from '@lcm/shared';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

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
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

import { CreateEventDialog, DeleteEventDialog, EditEventDialog } from './event-dialogs';

interface EventsTabProps {
  clusterId: string;
}

type DialogKind = 'edit' | 'delete';

const CATEGORY_LABEL: Record<EventCategory, string> = {
  growth: 'Growth',
  hardware_change: 'Hardware',
  openshift: 'OpenShift',
  note: 'Note',
};

const CATEGORY_VARIANT: Record<EventCategory, 'success' | 'warning' | 'secondary' | 'outline'> = {
  growth: 'warning',
  hardware_change: 'success',
  openshift: 'secondary',
  note: 'outline',
};

export function EventsTab({ clusterId }: EventsTabProps): React.JSX.Element {
  const [createOpen, setCreateOpen] = useState(false);
  const [target, setTarget] = useState<{ event: EventResponse; kind: DialogKind } | null>(null);

  const query = useQuery({
    queryKey: ['events', clusterId],
    queryFn: () => api.events.listByCluster(clusterId),
  });

  const events = query.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {events.length > 0
            ? `${events.length} ${events.length === 1 ? 'event' : 'events'} on the forecast`
            : 'No events yet.'}
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Add event
        </Button>
      </div>

      {query.isPending ? (
        <Skeleton />
      ) : query.isError ? (
        <ErrorRow message={query.error.message} />
      ) : events.length === 0 ? (
        <EmptyRow message="Add an event to annotate a growth period or hardware change." />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Date</TableHead>
                <TableHead className="w-32">Category</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="text-right">Consumption Δ</TableHead>
                <TableHead className="text-right">Capacity Δ</TableHead>
                <TableHead className="w-20 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground tabular-nums">
                    {event.effectiveDate}
                  </TableCell>
                  <TableCell>
                    <Badge variant={CATEGORY_VARIANT[event.category]}>
                      {CATEGORY_LABEL[event.category]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{event.title}</div>
                    {event.description ? (
                      <div className="text-xs text-muted-foreground">{event.description}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {event.consumptionDelta === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={cn(
                          'text-sm',
                          event.consumptionDelta >= 0 ? 'text-foreground' : 'text-destructive',
                        )}
                      >
                        {event.consumptionDelta >= 0 ? '+' : ''}
                        {formatNumber(event.consumptionDelta)} GB
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {event.capacityDelta === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={cn(
                          'text-sm',
                          event.capacityDelta >= 0 ? 'text-foreground' : 'text-destructive',
                        )}
                      >
                        {event.capacityDelta >= 0 ? '+' : ''}
                        {formatNumber(event.capacityDelta)} GB
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <IconButton onClick={() => setTarget({ event, kind: 'edit' })} title="Edit">
                        <Pencil className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton
                        onClick={() => setTarget({ event, kind: 'delete' })}
                        title="Delete"
                        destructive
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconButton>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateEventDialog open={createOpen} onOpenChange={setCreateOpen} clusterId={clusterId} />

      {target?.kind === 'edit' ? (
        <EditEventDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          event={target.event}
        />
      ) : null}
      {target?.kind === 'delete' ? (
        <DeleteEventDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          clusterId={clusterId}
          event={target.event}
        />
      ) : null}
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
