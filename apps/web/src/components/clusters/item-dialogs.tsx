import {
  itemAllocationRowInputSchema,
  itemCreateInputSchema,
  itemUpdateInputSchema,
} from '@lcm/shared';
import type { ItemKind, ItemResponse } from '@lcm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/form/confirm-dialog';
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
import {
  ApiError,
  api,
  type ItemAllocationAppendInputWire,
  type ItemCreateInputWire,
  type ItemUpdateInputWire,
} from '@/lib/api-client';
import { todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';

import { CategoryCombobox } from './category-combobox';

interface CommonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clusterId: string;
}

interface WithItemProps extends CommonDialogProps {
  item: ItemResponse;
}

function useItemMutations(clusterId: string): { invalidate: () => void } {
  const queryClient = useQueryClient();
  return {
    invalidate: () => {
      void queryClient.invalidateQueries({ queryKey: ['items', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['forecast', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['clusters'] });
    },
  };
}

function describeApiError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function parseDelta(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function useCategories(): string[] {
  const query = useQuery({
    queryKey: ['categories'],
    queryFn: api.settings.categories.list,
  });
  return (query.data ?? []).map((c) => c.name);
}

// ---------- Kind toggle ----------

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

// ---------- Create item ----------

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
        <form onSubmit={onSubmit} className="space-y-4">
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

// ---------- Edit item ----------

export function EditItemDialog({
  open,
  onOpenChange,
  clusterId,
  item,
}: WithItemProps): React.JSX.Element {
  const { invalidate } = useItemMutations(clusterId);
  const categories = useCategories();
  const isApp = item.kind === 'application';
  const [name, setName] = useState(item.name);
  const [category, setCategory] = useState(item.category);
  const [description, setDescription] = useState(item.description ?? '');
  const [effectiveDate, setEffectiveDate] = useState(item.effectiveDate);
  const [consumptionDelta, setConsumptionDelta] = useState(
    item.consumptionDelta === null ? '' : String(item.consumptionDelta),
  );
  const [capacityDelta, setCapacityDelta] = useState(
    item.capacityDelta === null ? '' : String(item.capacityDelta),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: (payload: ItemUpdateInputWire) => api.items.update(item.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success(isApp ? 'Application updated' : 'Event updated');
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not update item')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const trimmed = description.trim();
    const payload: ItemUpdateInputWire = {
      name,
      category,
      effectiveDate,
      description: trimmed.length > 0 ? trimmed : null,
      ...(isApp
        ? {}
        : {
            consumptionDelta: parseDelta(consumptionDelta),
            capacityDelta: parseDelta(capacityDelta),
          }),
    };
    const parsed = itemUpdateInputSchema.safeParse(payload);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const root = issue.path[0];
        if (typeof root === 'string') next[root] = issue.message;
      }
      setErrors(next);
      return;
    }
    mutation.mutate(payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {isApp ? 'application' : 'event'}</DialogTitle>
          <DialogDescription>
            Type is fixed for an existing item: {isApp ? 'Application' : 'Event'}.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label={isApp ? 'Name' : 'Title'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={errors.name}
            required
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={isApp ? 'Started at' : 'Effective date'}
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              error={errors.effectiveDate}
              required
            />
            <CategoryCombobox
              value={category}
              onChange={setCategory}
              categories={categories}
              error={errors.category}
            />
          </div>
          <Field
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {isApp ? null : (
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Consumption Δ (GB)"
                type="number"
                step="1"
                value={consumptionDelta}
                onChange={(e) => setConsumptionDelta(e.target.value)}
                error={errors.consumptionDelta}
              />
              <Field
                label="Capacity Δ (GB)"
                type="number"
                step="1"
                value={capacityDelta}
                onChange={(e) => setCapacityDelta(e.target.value)}
                error={errors.capacityDelta}
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Resize allocation (application-kind only) ----------

export function ResizeItemDialog({
  open,
  onOpenChange,
  clusterId,
  item,
}: WithItemProps): React.JSX.Element {
  const { invalidate } = useItemMutations(clusterId);
  const latest = item.allocations[item.allocations.length - 1];
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [amount, setAmount] = useState(String(latest?.amount ?? 0));
  const [errors, setErrors] = useState<{ effectiveFrom?: string; amount?: string }>({});

  const mutation = useMutation({
    mutationFn: (payload: ItemAllocationAppendInputWire) =>
      api.items.appendAllocation(item.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success('Allocation updated');
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(describeApiError(err, 'Resize failed'));
      if (err instanceof ApiError) {
        if (err.code === 'EFFECTIVE_BEFORE_START' || err.code === 'EFFECTIVE_NOT_MONOTONIC') {
          setErrors({ effectiveFrom: err.message });
        }
      }
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const payload: ItemAllocationAppendInputWire = {
      metricTypeKey: latest?.metricTypeKey ?? 'memory_gb',
      effectiveFrom,
      amount: Number(amount),
    };
    const parsed = itemAllocationRowInputSchema.safeParse(payload);
    if (!parsed.success) {
      const next: { effectiveFrom?: string; amount?: string } = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'effectiveFrom') next.effectiveFrom = issue.message;
        if (issue.path[0] === 'amount') next.amount = issue.message;
      }
      setErrors(next);
      return;
    }
    mutation.mutate(payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resize {item.name}</DialogTitle>
          <DialogDescription>
            Appends a new allocation row.
            {latest
              ? ` Most recent: ${latest.amount} ${latest.unit} from ${latest.effectiveFrom}.`
              : null}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Effective from"
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            error={errors.effectiveFrom}
            required
          />
          <Field
            label="New allocation (GB)"
            type="number"
            min="0"
            step="1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={errors.amount}
            required
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Add resize'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- End (application-kind only) ----------

export function EndItemDialog({
  open,
  onOpenChange,
  clusterId,
  item,
}: WithItemProps): React.JSX.Element {
  const { invalidate } = useItemMutations(clusterId);
  const [endedAt, setEndedAt] = useState(item.endedAt ?? todayIso());

  const mutation = useMutation({
    mutationFn: (payload: ItemUpdateInputWire) => api.items.update(item.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success(item.endedAt ? 'Application updated' : 'Application ended');
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not end application')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    mutation.mutate({ endedAt });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>End {item.name}</DialogTitle>
          <DialogDescription>
            Allocation stops contributing on this date. History is preserved.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Ended at"
            type="date"
            value={endedAt}
            onChange={(e) => setEndedAt(e.target.value)}
            required
          />
          <DialogFooter>
            {item.endedAt ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => mutation.mutate({ endedAt: null })}
                disabled={mutation.isPending}
              >
                Clear end date
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Delete item ----------

export function DeleteItemDialog({
  open,
  onOpenChange,
  clusterId,
  item,
}: WithItemProps): React.JSX.Element {
  const { invalidate } = useItemMutations(clusterId);
  const isApp = item.kind === 'application';
  const mutation = useMutation({
    mutationFn: () => api.items.delete(item.id),
    onSuccess: () => {
      invalidate();
      toast.success(isApp ? 'Application deleted' : 'Event deleted');
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not delete item')),
  });

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${item.name}?`}
      description={
        isApp
          ? 'Allocation history will be removed. This cannot be undone.'
          : 'This event will no longer affect the forecast.'
      }
      confirmLabel={isApp ? 'Delete application' : 'Delete event'}
      destructive
      pending={mutation.isPending}
      onConfirm={() => mutation.mutate()}
    />
  );
}
