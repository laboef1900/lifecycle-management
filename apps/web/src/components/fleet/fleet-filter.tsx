import { Funnel } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * Fleet console Filter control (#243 item 1): the archived toggle moves off
 * its stranded row into a popover attached to the toolbar above the tile grid
 * — a visible control attached to the list it filters (NN/g), with room for
 * future facets (state, runway, …).
 *
 * Mitigations for the known discoverability cost of putting the only filter
 * behind a menu (NN/g: hidden controls roughly halve discoverability): the
 * trigger carries an active-count badge (`Filter · 1`) and holds a steel
 * active tone while any non-default filter is on, so a non-default mixed view
 * is always explainable from the toolbar without opening the popover. Steel,
 * not amber: it is the interaction/info hue, and this state describes the
 * view, not a warning.
 *
 * The archived item is a native checkbox (real checkbox semantics for free);
 * Radix supplies `aria-expanded` on the trigger and focus return on close.
 * The label carries the live archived count once known — the console enables
 * the archived query while the popover is open so the count is real, never
 * a guess.
 */
export function FleetFilter({
  showArchived,
  onShowArchivedChange,
  archivedCount,
  open,
  onOpenChange,
}: {
  showArchived: boolean;
  onShowArchivedChange: (next: boolean) => void;
  /** Live archived-cluster count; null while the query has not resolved. */
  archivedCount: number | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}): React.JSX.Element {
  const activeCount = showArchived ? 1 : 0;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="chip"
          size="chip"
          data-testid="fleet-filter-button"
          className={cn(activeCount > 0 && 'border-steel/60 text-steel hover:border-steel')}
        >
          <Funnel className="h-3.5 w-3.5" aria-hidden />
          Filter
          {activeCount > 0 ? (
            <span data-testid="fleet-filter-count" aria-label={`${activeCount} filter active`}>
              · {activeCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-3">
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
          Filters
        </p>
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => onShowArchivedChange(event.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--accent)]"
          />
          <span>
            Show archived
            {archivedCount !== null ? ` (${archivedCount})` : ''}
          </span>
        </label>
      </PopoverContent>
    </Popover>
  );
}
