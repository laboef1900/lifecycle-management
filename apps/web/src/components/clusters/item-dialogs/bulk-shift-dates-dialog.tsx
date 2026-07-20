import type { ItemResponse } from '@lcm/shared';
import {
  formatDateIso,
  hasShiftCollision,
  isSupportedDate,
  MAX_SHIFT_BY_UNIT,
  shiftDateByUnit,
  type DateShiftUnit,
} from '@lcm/shared';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Field } from '@/components/form/field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { api, describeApiError, type ItemBulkShiftDatesInputWire } from '@/lib/api-client';

import { useItemMutations, type CommonDialogProps } from './shared';

type Direction = 'earlier' | 'later';

interface BulkShiftDatesDialogProps extends CommonDialogProps {
  /** The selected entries, in the order the table shows them. */
  items: ItemResponse[];
  /** Called after a successful shift so the caller can clear its selection. */
  onApplied: () => void;
}

/** Why an entry cannot take the current shift, if it cannot. */
type PreviewProblem = 'out-of-range' | 'collision';

interface PreviewRow {
  id: string;
  name: string;
  from: string;
  to: string;
  /** Extra dates that move with the entry, phrased for the operator. */
  cascade: string | null;
  problem: PreviewProblem | null;
}

/** Short per-row label; the fuller explanation lives in the alert below the list. */
const PROBLEM_LABEL: Record<PreviewProblem, string> = {
  'out-of-range': 'out of range',
  collision: 'date conflict',
};

const UNIT_OPTIONS: { value: DateShiftUnit; label: string }[] = [
  { value: 'days', label: 'Days' },
  { value: 'weeks', label: 'Weeks' },
  { value: 'months', label: 'Months' },
];

const DIRECTION_OPTIONS: { value: Direction; label: string }[] = [
  { value: 'later', label: 'Later' },
  { value: 'earlier', label: 'Earlier' },
];

function parseIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * Builds the old → new preview from the SAME shared date maths and the SAME
 * collision check the server applies, so what the operator confirms is exactly
 * what gets written — and every reason the server would reject the batch is
 * visible here first, rather than arriving as a 422 after clicking Apply.
 */
function buildPreview(items: ItemResponse[], amount: number, unit: DateShiftUnit): PreviewRow[] {
  return items.map((item) => {
    const shifted = shiftDateByUnit(parseIsoDate(item.effectiveDate), amount, unit);
    const moved: string[] = [];
    if (item.allocations.length > 0) {
      moved.push(
        `${item.allocations.length} allocation ${item.allocations.length === 1 ? 'date' : 'dates'}`,
      );
    }
    if (item.endedAt !== null) moved.push('the end date');

    const everyDateSupported =
      isSupportedDate(shifted) &&
      (item.endedAt === null ||
        isSupportedDate(shiftDateByUnit(parseIsoDate(item.endedAt), amount, unit))) &&
      item.allocations.every((allocation) =>
        isSupportedDate(shiftDateByUnit(parseIsoDate(allocation.effectiveFrom), amount, unit)),
      );

    const collides = hasShiftCollision(
      item.allocations.map((allocation) => ({
        metric: allocation.metricTypeKey,
        effectiveFrom: parseIsoDate(allocation.effectiveFrom),
      })),
      amount,
      unit,
    );

    const problem: PreviewProblem | null = !everyDateSupported
      ? 'out-of-range'
      : collides
        ? 'collision'
        : null;

    return {
      id: item.id,
      name: item.name,
      from: item.effectiveDate,
      to: isSupportedDate(shifted) ? formatDateIso(shifted) : '—',
      cascade: moved.length > 0 ? `also moves ${moved.join(' and ')}` : null,
      problem,
    };
  });
}

export function BulkShiftDatesDialog({
  open,
  onOpenChange,
  clusterId,
  items,
  onApplied,
}: BulkShiftDatesDialogProps): React.JSX.Element {
  const { invalidate } = useItemMutations(clusterId);
  const [direction, setDirection] = useState<Direction>('later');
  const [unit, setUnit] = useState<DateShiftUnit>('months');
  const [rawAmount, setRawAmount] = useState('1');

  const magnitude = Number.parseInt(rawAmount, 10);
  const max = MAX_SHIFT_BY_UNIT[unit];
  const amountError =
    !Number.isInteger(magnitude) || magnitude < 1
      ? 'Enter a whole number of 1 or more'
      : magnitude > max
        ? `At most ${max} ${unit}`
        : undefined;

  const amount = amountError === undefined ? (direction === 'earlier' ? -magnitude : magnitude) : 0;
  const preview = amountError === undefined ? buildPreview(items, amount, unit) : [];
  const outOfRange = preview.filter((row) => row.problem === 'out-of-range');
  const colliding = preview.filter((row) => row.problem === 'collision');
  const blockedRows = outOfRange.length + colliding.length;

  const mutation = useMutation({
    mutationFn: (payload: ItemBulkShiftDatesInputWire) => api.items.bulkShiftDates(payload),
    onSuccess: (result) => {
      invalidate();
      toast.success(
        `Shifted ${result.shifted} ${result.shifted === 1 ? 'entry' : 'entries'} by ${magnitude} ${unit}`,
      );
      onApplied();
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not shift the dates')),
  });

  const blocked = amountError !== undefined || blockedRows > 0 || items.length === 0;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (blocked) return;
    mutation.mutate({ itemIds: items.map((item) => item.id), shift: { amount, unit } });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Shift dates for {items.length} {items.length === 1 ? 'entry' : 'entries'}
          </DialogTitle>
          <DialogDescription>
            Every selected app and event moves by the same amount. An application&apos;s allocation
            dates and end date move with it, so its timeline stays intact. Review the dates below
            before applying — this rewrites the forecast.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <span className="block text-sm font-medium">Direction</span>
              <SegmentedControl
                value={direction}
                onValueChange={setDirection}
                options={DIRECTION_OPTIONS}
                ariaLabel="Shift direction"
              />
            </div>
            <Field
              label="Amount"
              type="number"
              min={1}
              max={max}
              step={1}
              inputMode="numeric"
              className="w-24"
              value={rawAmount}
              onChange={(e) => setRawAmount(e.target.value)}
              error={amountError}
              required
            />
            <div className="space-y-1.5">
              <span className="block text-sm font-medium">Unit</span>
              <SegmentedControl
                value={unit}
                onValueChange={setUnit}
                options={UNIT_OPTIONS}
                ariaLabel="Shift unit"
              />
            </div>
          </div>

          <section aria-label="Date change preview" className="space-y-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Preview
            </h3>
            <ul className="max-h-64 space-y-1 overflow-y-auto rounded-[var(--radius)] border border-border p-2">
              {preview.length === 0 ? (
                <li className="p-1 text-sm text-muted-foreground">
                  Enter a valid amount to preview the new dates.
                </li>
              ) : (
                preview.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-baseline justify-between gap-3 p-1 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {row.name}
                      {row.cascade ? (
                        <span className="ml-2 text-xs text-muted-foreground">({row.cascade})</span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
                      <span className="text-muted-foreground line-through">{row.from}</span>
                      <ArrowRight aria-hidden className="h-3 w-3 text-muted-foreground" />
                      {row.problem === null ? (
                        <span className="text-foreground">{row.to}</span>
                      ) : (
                        // The icon carries the same meaning as the colour, so
                        // the state survives a forced-colors palette or a
                        // colour-vision deficiency (WCAG 1.4.1).
                        <span className="flex items-center gap-1 font-sans text-destructive">
                          <AlertTriangle aria-hidden className="h-3 w-3" />
                          {PROBLEM_LABEL[row.problem]}
                        </span>
                      )}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </section>

          {outOfRange.length > 0 ? (
            <p role="alert" className="text-xs text-destructive">
              {outOfRange.length} {outOfRange.length === 1 ? 'entry lands' : 'entries land'} outside
              the supported date range. Reduce the shift before applying.
            </p>
          ) : null}

          {colliding.length > 0 ? (
            <p role="alert" className="text-xs text-destructive">
              {colliding.length}{' '}
              {colliding.length === 1
                ? 'entry would put two of its allocation dates on the same day'
                : 'entries would put two of their allocation dates on the same day'}{' '}
              (shifting by months clamps to the end of a shorter month). Change the amount or unit,
              or deselect{' '}
              {colliding.length === 1 ? `"${colliding[0]?.name ?? 'it'}"` : 'the flagged entries'}{' '}
              before applying.
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={blocked || mutation.isPending}>
              {mutation.isPending
                ? 'Shifting…'
                : `Shift ${items.length} ${items.length === 1 ? 'entry' : 'entries'}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
