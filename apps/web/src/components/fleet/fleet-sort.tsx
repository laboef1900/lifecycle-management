import { ArrowDownUp } from 'lucide-react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** The tile sort orders offered by the fleet console (#267). */
export type ClusterSortMode = 'orderBy' | 'name' | 'size';

/** Visible label for each sort mode; also the option order in the selector. */
export const CLUSTER_SORT_LABELS: Record<ClusterSortMode, string> = {
  orderBy: 'Order-by date',
  name: 'Name',
  size: 'Size',
};

const SORT_MODES = Object.keys(CLUSTER_SORT_LABELS) as ClusterSortMode[];

/**
 * Fleet console Sort control (#267): replaces the old static "Sorted by
 * order-by date" note with a working selector. Order-by date is the default
 * (procurement urgency); Name is alphabetical; Size is total memory capacity,
 * largest first. Radix Select supplies the combobox semantics, keyboard
 * operation, and focus return; the trigger carries an explicit accessible name
 * because its visible text is the current value, not a label.
 */
export function FleetSort({
  value,
  onValueChange,
}: {
  value: ClusterSortMode;
  onValueChange: (next: ClusterSortMode) => void;
}): React.JSX.Element {
  return (
    <Select value={value} onValueChange={(next) => onValueChange(next as ClusterSortMode)}>
      <SelectTrigger
        aria-label="Sort clusters"
        data-testid="fleet-sort-trigger"
        className="h-8 w-[172px] gap-2"
      >
        <ArrowDownUp className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {SORT_MODES.map((mode) => (
          <SelectItem key={mode} value={mode}>
            {CLUSTER_SORT_LABELS[mode]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
