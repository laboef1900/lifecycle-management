import type { MetricStateResponse } from '@lcm/shared';
import { clusterUpdateInputSchema } from '@lcm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/form/confirm-dialog';
import { useFocusFirstInvalidField } from '@/components/form/field';
import { REQUIRED_AMOUNT_MESSAGE, parseRequiredAmount } from '@/components/form/required-amount';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, describeApiError, type ClusterUpdateInputWire } from '@/lib/api-client';

interface BaselineEditFormProps {
  clusterId: string;
}

interface MetricEdit {
  consumption: string | null;
  capacity: string | null;
}

type MetricField = 'consumption' | 'capacity';

/** Keyed by control id, so a key doubles as the DOM hook the error paragraph uses. */
type FieldErrors = Record<string, string | undefined>;

const DATE_ID = 'baseline-date';

/**
 * Positional rather than keyed by `metricTypeKey`: the key is server-supplied
 * with no format contract (`z.string().min(1)` in `@lcm/shared`), and it would
 * be interpolated straight into an `id`/`htmlFor` pair here. The index is also
 * what a Zod issue path carries (`baselines[i].baselineCapacity`), so mapping an
 * issue onto a control needs no lookup table.
 */
function metricControlId(index: number, field: MetricField): string {
  return `baseline-metric-${index}-${field}`;
}

/**
 * Whether a raw edit differs from the number the server holds.
 *
 * `Object.is` rather than `!==` so the NaN case is stated rather than relied on:
 * a blank or unparseable edit is *always* a change, which is the point — it must
 * enable the submit so the operator gets an error, instead of being silently
 * ignored and re-sending the old value.
 */
function differsFromServer(raw: string, serverValue: number): boolean {
  return !Object.is(parseRequiredAmount(raw), serverValue);
}

export function BaselineEditForm({ clusterId }: BaselineEditFormProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const clusterQuery = useQuery({
    queryKey: ['cluster', clusterId],
    queryFn: () => api.clusters.get(clusterId),
  });

  const [dateEdit, setDateEdit] = React.useState<string | null>(null);
  const [metricEdits, setMetricEdits] = React.useState<Record<string, MetricEdit>>({});
  const [errors, setErrors] = React.useState<FieldErrors>({});
  /**
   * The exact wire payload the confirm dialog is asking about — non-null is what
   * opens the dialog. Snapshotting it (rather than rebuilding at confirm time)
   * keeps the confirm honest: this query can refetch while the modal is up, and
   * a rebuild would then send numbers the operator never saw on the summary.
   */
  const [pendingInput, setPendingInput] = React.useState<ClusterUpdateInputWire | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  useFocusFirstInvalidField(formRef, errors);

  const serverDate = clusterQuery.data?.baselineDate ?? '';
  const metrics = clusterQuery.data?.metrics ?? [];

  const date = dateEdit ?? serverDate;

  const getMetricRawValue = (metric: MetricStateResponse, field: MetricField): string => {
    const edit = metricEdits[metric.metricTypeKey];
    if (edit && edit[field] !== null) return edit[field] as string;
    const serverValue =
      field === 'consumption' ? metric.baselineConsumption : metric.baselineCapacity;
    return String(serverValue);
  };

  /**
   * The value this field would post. `NaN` for a blank or unparseable edit — see
   * `parseRequiredAmount`: `Number('')` is `0` and `positiveAmount` accepts `0`,
   * so coercing here would post a fabricated zero baseline as if the operator
   * had typed it.
   */
  const getMetricNumericValue = (metric: MetricStateResponse, field: MetricField): number => {
    const edit = metricEdits[metric.metricTypeKey];
    if (edit && edit[field] !== null) return parseRequiredAmount(edit[field] as string);
    return field === 'consumption' ? metric.baselineConsumption : metric.baselineCapacity;
  };

  const setMetricValue = (key: string, field: MetricField, raw: string): void => {
    setMetricEdits((prev) => {
      const current = prev[key] ?? { consumption: null, capacity: null };
      return { ...prev, [key]: { ...current, [field]: raw } };
    });
  };

  const mutation = useMutation({
    mutationFn: (input: ClusterUpdateInputWire) => api.clusters.update(clusterId, input),
    onSuccess: (data) => {
      queryClient.setQueryData(['cluster', clusterId], data);
      void queryClient.invalidateQueries({ queryKey: ['forecast', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['clusters'] });
      setDateEdit(null);
      setMetricEdits({});
      setErrors({});
      setPendingInput(null);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not save baseline')),
  });

  const dateChanged = dateEdit !== null && dateEdit !== serverDate;
  const baselinesChanged = metrics.some((m) => {
    const edit = metricEdits[m.metricTypeKey];
    if (!edit) return false;
    return (
      (edit.consumption !== null && differsFromServer(edit.consumption, m.baselineConsumption)) ||
      (edit.capacity !== null && differsFromServer(edit.capacity, m.baselineCapacity))
    );
  });
  const dirty = dateChanged || baselinesChanged;

  /**
   * The form is `noValidate`, so this is the only gate — and it runs *before*
   * the confirm dialog opens, so the operator is never asked to confirm a
   * rewrite that cannot happen.
   *
   * Blank fields get the form's own words; everything else is judged by the
   * shared `clusterUpdateInputSchema`, which is the same contract the server
   * enforces. Nothing about the bounds is restated here.
   */
  const handleSave = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!dirty) return;

    const input: ClusterUpdateInputWire = {};
    if (dateChanged) input.baselineDate = date;
    if (baselinesChanged) {
      input.baselines = metrics.map((m) => ({
        metricTypeKey: m.metricTypeKey,
        baselineConsumption: getMetricNumericValue(m, 'consumption'),
        baselineCapacity: getMetricNumericValue(m, 'capacity'),
      }));
    }

    const next: FieldErrors = {};
    if (dateChanged && date.trim().length === 0) next[DATE_ID] = 'Enter a baseline date.';
    if (baselinesChanged) {
      metrics.forEach((m, index) => {
        for (const field of ['consumption', 'capacity'] as const) {
          const raw = metricEdits[m.metricTypeKey]?.[field];
          if (raw !== undefined && raw !== null && raw.trim().length === 0) {
            next[metricControlId(index, field)] = REQUIRED_AMOUNT_MESSAGE;
          }
        }
      });
    }

    const unowned: string[] = [];
    const parsed = clusterUpdateInputSchema.safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const [root, index, leaf] = issue.path;
        if (root === 'baselineDate') {
          next[DATE_ID] ??= issue.message;
          continue;
        }
        const field =
          leaf === 'baselineConsumption'
            ? 'consumption'
            : leaf === 'baselineCapacity'
              ? 'capacity'
              : null;
        if (root === 'baselines' && typeof index === 'number' && field !== null) {
          next[metricControlId(index, field)] ??= issue.message;
          continue;
        }
        // The "at least one field" refine, or a metricTypeKey the server sent —
        // no control to point at, so it would otherwise fail silently.
        unowned.push(issue.message);
      }
    }

    const hasFieldError = Object.values(next).some((message) => message !== undefined);
    if (hasFieldError || unowned.length > 0) {
      // A fresh object every failed submit, which is what re-fires the focus move.
      setErrors(next);
      if (!hasFieldError) toast.error(unowned[0] ?? 'Could not save baseline');
      return;
    }

    setErrors({});
    setPendingInput(input);
  };

  return (
    <Card className="p-4">
      <header className="mb-4">
        <h2 className="text-base font-semibold">Baseline</h2>
        <p className="text-sm text-fg-muted">
          The starting date and per-metric values that every forecast point is computed from.
        </p>
      </header>
      {/* `noValidate`: the browser's own bubble fires *before* the submit event,
          so it preempts the error path below — transient, unstyled, one field at
          a time, and gone on the next keystroke. `min={0}` stays on the number
          inputs: with native validation off it can no longer raise a bubble, and
          it still clamps the stepper. The contract, not the attribute, is what
          rejects a negative value now. */}
      <form ref={formRef} onSubmit={handleSave} className="space-y-3" noValidate>
        {/* Label and control are siblings, not nested: a wrapping `<label>`
            would fold the error paragraph into the field's own label text. */}
        <div>
          <label
            htmlFor={DATE_ID}
            className="block text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle"
          >
            Baseline date
          </label>
          <Input
            id={DATE_ID}
            type="date"
            value={date}
            onChange={(e) => setDateEdit(e.target.value)}
            aria-invalid={errors[DATE_ID] ? 'true' : undefined}
            aria-describedby={errors[DATE_ID] ? `${DATE_ID}-error` : undefined}
            className="mt-1"
          />
          {errors[DATE_ID] ? (
            <p id={`${DATE_ID}-error`} className="mt-1 text-xs text-destructive">
              {errors[DATE_ID]}
            </p>
          ) : null}
        </div>
        {metrics.map((m, index) => (
          <div
            key={m.metricTypeKey}
            className="space-y-2 rounded-[var(--radius)] border border-border p-3"
          >
            <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
              {m.metricTypeDisplayName} ({m.unit})
            </p>
            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  ['consumption', 'Baseline consumption'],
                  ['capacity', 'Baseline capacity'],
                ] as ReadonlyArray<readonly [MetricField, string]>
              ).map(([field, caption]) => {
                const id = metricControlId(index, field);
                const error = errors[id];
                return (
                  <div key={field}>
                    <label htmlFor={id} className="block text-[11px] text-fg-muted">
                      {caption}
                    </label>
                    <Input
                      id={id}
                      type="number"
                      step="any"
                      min={0}
                      // The caption alone reads as "Baseline consumption" on
                      // every metric card; the accessible name has to say which
                      // metric, so it names the metric too.
                      aria-label={`${m.metricTypeDisplayName} ${caption.toLowerCase()}`}
                      value={getMetricRawValue(m, field)}
                      onChange={(e) => setMetricValue(m.metricTypeKey, field, e.target.value)}
                      aria-invalid={error ? 'true' : undefined}
                      aria-describedby={error ? `${id}-error` : undefined}
                      className="mt-1"
                    />
                    {error ? (
                      <p id={`${id}-error`} className="mt-1 text-xs text-destructive">
                        {error}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <div className="flex items-center justify-end">
          {/* Not `destructive`: coral is the delete token (the Delete button two
              cards below wears it), and spending it on a save teaches users to
              discount red. This submit opens the confirm dialog below, which is
              where the weight of the action belongs — hence the ellipsis, and
              hence a label that names the real consequence instead of "Save". */}
          <Button type="submit" variant="accent" size="sm" disabled={!dirty || mutation.isPending}>
            Rewrite baseline…
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={pendingInput !== null}
        onOpenChange={(open) => {
          if (!open) setPendingInput(null);
        }}
        title="Rewrite baseline?"
        description="Changing the baseline date or values rewrites every forecast point for this cluster. Confirm only if you intentionally want to reset historical assumptions."
        confirmLabel="Rewrite baseline"
        destructive
        pending={mutation.isPending}
        onConfirm={() => {
          if (pendingInput !== null) mutation.mutate(pendingInput);
        }}
      />
    </Card>
  );
}
