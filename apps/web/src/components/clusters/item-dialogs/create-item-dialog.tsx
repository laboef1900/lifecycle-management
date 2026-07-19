import { itemCreateInputSchema } from '@lcm/shared';
import type { ItemKind } from '@lcm/shared';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
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
import { api, describeApiError, type ItemCreateInputWire } from '@/lib/api-client';
import { todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';

import { CategoryCombobox } from '../category-combobox';
import { parseDelta, useCategories, useItemMutations, type CommonDialogProps } from './shared';

function KindToggle({
  value,
  onChange,
}: {
  value: ItemKind;
  onChange: (kind: ItemKind) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium">Type</span>
      <div className="inline-flex rounded-[var(--radius)] border border-input bg-background p-0.5">
        {(['application', 'event'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => onChange(kind)}
            aria-pressed={value === kind}
            className={cn(
              'rounded-[calc(var(--radius)-2px)] px-3 py-1 text-sm font-medium capitalize transition-colors',
              value === kind
                ? 'bg-accent-soft text-accent'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {kind}
          </button>
        ))}
      </div>
    </div>
  );
}

interface CreateFormState {
  kind: ItemKind;
  name: string;
  category: string;
  description: string;
  effectiveDate: string;
  // application
  allocationAmount: string;
  // event
  consumptionDelta: string;
  capacityDelta: string;
}

const blankCreateForm = (): CreateFormState => ({
  kind: 'application',
  name: '',
  category: '',
  description: '',
  effectiveDate: todayIso(),
  allocationAmount: '0',
  consumptionDelta: '',
  capacityDelta: '',
});

type CreateErrors = Partial<Record<keyof CreateFormState, string>>;

export function CreateItemDialog({
  open,
  onOpenChange,
  clusterId,
}: CommonDialogProps): React.JSX.Element {
  const { invalidate } = useItemMutations(clusterId);
  const categories = useCategories();
  const [form, setForm] = useState<CreateFormState>(blankCreateForm());
  const [errors, setErrors] = useState<CreateErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalidField(formRef, errors);

  const reset = (): void => {
    setForm(blankCreateForm());
    setErrors({});
  };

  const mutation = useMutation({
    mutationFn: (payload: ItemCreateInputWire) => api.items.create(clusterId, payload),
    onSuccess: () => {
      invalidate();
      toast.success(form.kind === 'application' ? 'Application added' : 'Event added');
      onOpenChange(false);
      reset();
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not add item')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const description = form.description.trim();
    const payload: ItemCreateInputWire =
      form.kind === 'application'
        ? {
            kind: 'application',
            name: form.name,
            category: form.category,
            effectiveDate: form.effectiveDate,
            allocations: [
              {
                metricTypeKey: 'memory_gb',
                effectiveFrom: form.effectiveDate,
                amount: Number(form.allocationAmount),
              },
            ],
            ...(description.length > 0 && { description }),
          }
        : {
            kind: 'event',
            name: form.name,
            category: form.category,
            effectiveDate: form.effectiveDate,
            metricTypeKey: 'memory_gb',
            consumptionDelta: parseDelta(form.consumptionDelta),
            capacityDelta: parseDelta(form.capacityDelta),
            ...(description.length > 0 && { description }),
          };

    const parsed = itemCreateInputSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: CreateErrors = {};
      for (const issue of parsed.error.issues) {
        const root = issue.path[0];
        if (root === 'name') fieldErrors.name = issue.message;
        else if (root === 'category') fieldErrors.category = issue.message;
        else if (root === 'effectiveDate') fieldErrors.effectiveDate = issue.message;
        else if (root === 'allocations') fieldErrors.allocationAmount = issue.message;
        else if (root === 'consumptionDelta') fieldErrors.consumptionDelta = issue.message;
        else if (root === 'capacityDelta') fieldErrors.capacityDelta = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }
    mutation.mutate(payload);
  };

  const isApp = form.kind === 'application';

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (!value) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add item</DialogTitle>
          <DialogDescription>
            An application consumes capacity over time; an event annotates the forecast with a
            one-off capacity/consumption delta.
          </DialogDescription>
        </DialogHeader>
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4">
          <KindToggle value={form.kind} onChange={(kind) => setForm({ ...form, kind })} />
          <Field
            label={isApp ? 'Name' : 'Title'}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            error={errors.name}
            placeholder={isApp ? 'openshift-lab' : 'Wachstum Q4'}
            required
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={isApp ? 'Started at' : 'Effective date'}
              type="date"
              value={form.effectiveDate}
              onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })}
              error={errors.effectiveDate}
              required
            />
            <CategoryCombobox
              value={form.category}
              onChange={(value) => setForm({ ...form, category: value })}
              categories={categories}
              error={errors.category}
            />
          </div>
          <Field
            label="Description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Optional"
          />
          {isApp ? (
            <Field
              label="Initial memory allocation (GB)"
              type="number"
              min="0"
              step="1"
              value={form.allocationAmount}
              onChange={(e) => setForm({ ...form, allocationAmount: e.target.value })}
              error={errors.allocationAmount}
              required
            />
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Consumption Δ (GB)"
                type="number"
                step="1"
                value={form.consumptionDelta}
                onChange={(e) => setForm({ ...form, consumptionDelta: e.target.value })}
                error={errors.consumptionDelta}
                placeholder="e.g. 750"
              />
              <Field
                label="Capacity Δ (GB)"
                type="number"
                step="1"
                value={form.capacityDelta}
                onChange={(e) => setForm({ ...form, capacityDelta: e.target.value })}
                error={errors.capacityDelta}
                placeholder="e.g. 4096"
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={mutation.isPending}>
              {mutation.isPending ? 'Adding…' : isApp ? 'Add application' : 'Add event'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
