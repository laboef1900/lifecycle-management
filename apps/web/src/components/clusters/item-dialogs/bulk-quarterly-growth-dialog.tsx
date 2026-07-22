import { itemBulkCreateQuarterlyGrowthInputSchema, MAX_QUARTERLY_GROWTH_ITEMS } from '@lcm/shared';
import { useMutation } from '@tanstack/react-query';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Field, useFocusFirstInvalidField } from '@/components/form/field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  api,
  describeApiError,
  type ItemBulkCreateQuarterlyGrowthInputWire,
} from '@/lib/api-client';

import { CategoryCombobox } from '../category-combobox';
import { parseDelta, useCategories, useItemMutations, type CommonDialogProps } from './shared';

const QUARTERS = [1, 2, 3, 4] as const;
type Quarter = (typeof QUARTERS)[number];

/** Calendar-quarter start month (0-indexed) used for each row's default date. */
const QUARTER_START_MONTH: Record<Quarter, number> = { 1: 0, 2: 3, 3: 6, 4: 9 };

function quarterStartDate(year: number, quarter: Quarter): string {
  const month = QUARTER_START_MONTH[quarter];
  return `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

const currentYear = (): number => new Date().getUTCFullYear();

interface QuarterRowState {
  quarter: Quarter;
  included: boolean;
  name: string;
  effectiveDate: string;
  consumptionDelta: string;
  capacityDelta: string;
}

function blankRows(year: number): QuarterRowState[] {
  return QUARTERS.map((quarter) => ({
    quarter,
    included: true,
    name: `Wachstum Q${quarter}`,
    effectiveDate: quarterStartDate(year, quarter),
    consumptionDelta: '',
    capacityDelta: '',
  }));
}

interface RowErrors {
  name?: string;
  effectiveDate?: string;
  consumptionDelta?: string;
  capacityDelta?: string;
}

export function BulkQuarterlyGrowthDialog({
  open,
  onOpenChange,
  clusterId,
}: CommonDialogProps): React.JSX.Element {
  const { invalidate } = useItemMutations(clusterId);
  const categories = useCategories();
  const [category, setCategory] = useState('Growth');
  const [description, setDescription] = useState('');
  const [year, setYear] = useState(currentYear);
  const [rows, setRows] = useState<QuarterRowState[]>(() => blankRows(currentYear()));
  const [categoryError, setCategoryError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [rowErrors, setRowErrors] = useState<Partial<Record<Quarter, RowErrors>>>({});
  const formRef = useRef<HTMLFormElement>(null);
  // Memoized so the merged map only gets a new reference when an error
  // actually changes — `useFocusFirstInvalidField` re-focuses the first
  // invalid field on every reference change, and an object literal rebuilt
  // on every render would refire that on each keystroke, yanking focus away
  // from whichever field the operator is actively fixing.
  const focusErrors = useMemo(
    () => ({
      category: categoryError,
      ...Object.fromEntries(
        Object.entries(rowErrors).flatMap(([quarter, errors]) =>
          Object.entries(errors ?? {}).map(([field, message]) => [`${quarter}-${field}`, message]),
        ),
      ),
    }),
    [categoryError, rowErrors],
  );
  useFocusFirstInvalidField(formRef, focusErrors);

  const reset = (): void => {
    const year0 = currentYear();
    setCategory('Growth');
    setDescription('');
    setYear(year0);
    setRows(blankRows(year0));
    setCategoryError(undefined);
    setFormError(undefined);
    setRowErrors({});
  };

  const mutation = useMutation({
    mutationFn: (payload: ItemBulkCreateQuarterlyGrowthInputWire) =>
      api.items.bulkCreateQuarterlyGrowth(clusterId, payload),
    onSuccess: (result) => {
      invalidate();
      toast.success(
        `Added ${result.created} quarterly growth ${result.created === 1 ? 'entry' : 'entries'}`,
      );
      onOpenChange(false);
      reset();
    },
    onError: (err) =>
      toast.error(describeApiError(err, 'Could not add the quarterly growth entries')),
  });

  const updateRow = (quarter: Quarter, patch: Partial<QuarterRowState>): void => {
    setRows((prev) => prev.map((row) => (row.quarter === quarter ? { ...row, ...patch } : row)));
  };

  const onYearChange = (raw: string): void => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return;
    setYear(parsed);
    // Re-derive every row's default date for the new year. An operator who
    // already hand-edited a date can just re-edit it after switching years —
    // silently keeping a stale date tied to the old year would be more
    // surprising than resetting it.
    setRows((prev) =>
      prev.map((row) => ({ ...row, effectiveDate: quarterStartDate(parsed, row.quarter) })),
    );
  };

  const includedRows = rows.filter((row) => row.included);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setCategoryError(undefined);
    setFormError(undefined);
    setRowErrors({});

    const trimmedDescription = description.trim();
    const payload: ItemBulkCreateQuarterlyGrowthInputWire = {
      category,
      metricTypeKey: 'memory_gb',
      entries: includedRows.map((row) => ({
        name: row.name,
        effectiveDate: row.effectiveDate,
        consumptionDelta: parseDelta(row.consumptionDelta),
        capacityDelta: parseDelta(row.capacityDelta),
      })),
      ...(trimmedDescription.length > 0 && { description: trimmedDescription }),
    };

    const parsed = itemBulkCreateQuarterlyGrowthInputSchema.safeParse(payload);
    if (!parsed.success) {
      const nextRowErrors: Partial<Record<Quarter, RowErrors>> = {};
      let nextCategoryError: string | undefined;
      let nextFormError: string | undefined;
      for (const issue of parsed.error.issues) {
        const [root, index, field] = issue.path;
        if (root === 'category') {
          nextCategoryError = issue.message;
        } else if (root === 'entries' && typeof index === 'number') {
          const quarter = includedRows[index]?.quarter;
          if (quarter === undefined) continue;
          const rowError = nextRowErrors[quarter] ?? {};
          if (field === 'name') rowError.name = issue.message;
          else if (field === 'effectiveDate') rowError.effectiveDate = issue.message;
          else if (field === 'consumptionDelta') rowError.consumptionDelta = issue.message;
          else if (field === 'capacityDelta') rowError.capacityDelta = issue.message;
          nextRowErrors[quarter] = rowError;
        } else if (root === 'entries') {
          nextFormError = issue.message;
        }
      }
      setCategoryError(nextCategoryError);
      setRowErrors(nextRowErrors);
      setFormError(nextFormError);
      return;
    }
    mutation.mutate(payload);
  };

  const includedCount = includedRows.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (!value) reset();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add quarterly growth</DialogTitle>
          <DialogDescription>
            Set a year of projected growth in one form — up to {MAX_QUARTERLY_GROWTH_ITEMS} events,
            one per quarter, sharing the same category and metric.
          </DialogDescription>
        </DialogHeader>
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Year"
              type="number"
              inputMode="numeric"
              value={String(year)}
              onChange={(e) => onYearChange(e.target.value)}
              required
            />
            <CategoryCombobox
              value={category}
              onChange={setCategory}
              categories={categories}
              error={categoryError}
            />
          </div>
          <Field
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional, applied to every quarter"
          />

          <div className="space-y-3">
            {rows.map((row) => (
              <QuarterRow
                key={row.quarter}
                row={row}
                errors={rowErrors[row.quarter]}
                onChange={(patch) => updateRow(row.quarter, patch)}
              />
            ))}
          </div>

          {formError ? (
            <p role="alert" className="text-xs text-destructive">
              {formError}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="accent"
              disabled={mutation.isPending || includedCount === 0}
            >
              {mutation.isPending
                ? 'Adding…'
                : `Add ${includedCount} ${includedCount === 1 ? 'entry' : 'entries'}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function QuarterRow({
  row,
  errors,
  onChange,
}: {
  row: QuarterRowState;
  errors: RowErrors | undefined;
  onChange: (patch: Partial<QuarterRowState>) => void;
}): React.JSX.Element {
  const prefix = `quarter-${row.quarter}`;
  return (
    <div className="rounded-[var(--radius)] border border-border p-3">
      <label className="mb-2 flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={row.included}
          onChange={(e) => onChange({ included: e.target.checked })}
          className="h-4 w-4 cursor-pointer rounded-[4px] border border-input accent-[var(--accent)]"
        />
        Q{row.quarter}
      </label>
      {row.included ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field
              id={`${prefix}-name`}
              label="Title"
              value={row.name}
              onChange={(e) => onChange({ name: e.target.value })}
              error={errors?.name}
              required
            />
            <Field
              id={`${prefix}-effective-date`}
              label="Effective date"
              type="date"
              value={row.effectiveDate}
              onChange={(e) => onChange({ effectiveDate: e.target.value })}
              error={errors?.effectiveDate}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field
              id={`${prefix}-consumption-delta`}
              label="Consumption Δ (GB)"
              type="number"
              step="1"
              value={row.consumptionDelta}
              onChange={(e) => onChange({ consumptionDelta: e.target.value })}
              error={errors?.consumptionDelta}
              placeholder="e.g. 750"
            />
            <Field
              id={`${prefix}-capacity-delta`}
              label="Capacity Δ (GB)"
              type="number"
              step="1"
              value={row.capacityDelta}
              onChange={(e) => onChange({ capacityDelta: e.target.value })}
              error={errors?.capacityDelta}
              placeholder="e.g. 4096"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
