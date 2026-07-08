import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api-client';

import { STATE_LABELS, type WithHostProps } from './shared';

/**
 * Read-only side panel that lists every lifecycle event recorded for a host,
 * oldest first (the API already returns them sorted by occurredAt). Uses a
 * Dialog for consistency with the other host actions — the codebase's Sheet
 * primitive is a fixed-width left-side nav drawer rather than a general
 * content panel, so reusing Dialog here keeps the look uniform across all
 * "host row" actions.
 *
 * Fetching is gated by `open` so the query doesn't fire until the user
 * actually opens the panel; the `host.id`-scoped key means re-opening a
 * different host reads its own cache entry. Action is shown for all states,
 * including disposed and fresh hosts (which simply render "No history yet.").
 */
export function HostHistoryDialog({
  open,
  onOpenChange,
  host,
}: Omit<WithHostProps, 'clusterId'>): React.JSX.Element {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['host-lifecycle', host.id],
    queryFn: () => api.hosts.listLifecycle(host.id),
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>History · {host.name}</DialogTitle>
          <DialogDescription>
            Lifecycle transitions recorded for this host, oldest first.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-muted/60" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-[var(--radius)] border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error instanceof Error ? error.message : 'Could not load history'}
          </div>
        ) : !data || data.length === 0 ? (
          <p className="rounded-[var(--radius)] border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
            No history yet.
          </p>
        ) : (
          <ol className="space-y-2">
            {data.map((event) => (
              <li
                key={event.id}
                className="rounded-[var(--radius)] border border-border bg-background/50 p-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {event.occurredAt}
                  </span>
                  <span className="text-sm">
                    {event.fromState ? (
                      <span className="text-muted-foreground">{STATE_LABELS[event.fromState]}</span>
                    ) : (
                      <span className="text-muted-foreground italic">Initial</span>
                    )}
                    <span className="px-1.5 text-muted-foreground">&rarr;</span>
                    <span className="font-medium">{STATE_LABELS[event.toState]}</span>
                  </span>
                </div>
                {event.note ? (
                  <p className="mt-1.5 whitespace-pre-wrap text-sm text-muted-foreground">
                    {event.note}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
