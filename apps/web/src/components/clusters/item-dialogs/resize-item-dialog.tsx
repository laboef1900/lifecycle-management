import { itemAllocationRowInputSchema } from '@lcm/shared';
import { useMutation } from '@tanstack/react-query';
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
import {
  ApiError,
  api,
  describeApiError,
  type ItemAllocationAppendInputWire,
} from '@/lib/api-client';
import { todayIso } from '@/lib/format';

import { useItemMutations, type WithItemProps } from './shared';

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
