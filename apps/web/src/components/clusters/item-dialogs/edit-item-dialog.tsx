import { itemUpdateInputSchema } from '@lcm/shared';
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
import { api, describeApiError, type ItemUpdateInputWire } from '@/lib/api-client';

import { CategoryCombobox } from '../category-combobox';
import { parseDelta, useCategories, useItemMutations, type WithItemProps } from './shared';

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
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalidField(formRef, errors);

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
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4">
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
