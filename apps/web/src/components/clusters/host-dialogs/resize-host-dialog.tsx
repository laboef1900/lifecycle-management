import { capacityRowInputSchema } from '@lcm/shared';
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
import { ApiError, api, describeApiError, type CapacityAppendInputWire } from '@/lib/api-client';
import { todayIso } from '@/lib/format';

import { mapIssuesToFieldErrors, useHostMutations, type WithHostProps } from './shared';

export function ResizeHostDialog({
  open,
  onOpenChange,
  clusterId,
  host,
}: WithHostProps): React.JSX.Element {
  const { invalidate } = useHostMutations(clusterId);
  const latest = host.capacities[host.capacities.length - 1];
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [amount, setAmount] = useState(String(latest?.amount ?? 0));
  const [errors, setErrors] = useState<{ effectiveFrom?: string; amount?: string }>({});

  const mutation = useMutation({
    mutationFn: (payload: CapacityAppendInputWire) => api.hosts.appendCapacity(host.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success('Capacity updated');
      onOpenChange(false);
    },
    onError: (err) => {
      const message = describeApiError(err, 'Resize failed');
      toast.error(message);
      if (err instanceof ApiError) {
        if (err.code === 'EFFECTIVE_BEFORE_COMMISSION' || err.code === 'EFFECTIVE_NOT_MONOTONIC') {
          setErrors({ effectiveFrom: err.message });
        }
      }
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const payload: CapacityAppendInputWire = {
      metricTypeKey: latest?.metricTypeKey ?? 'memory_gb',
      effectiveFrom,
      amount: Number(amount),
    };
    const parsed = capacityRowInputSchema.safeParse(payload);
    if (!parsed.success) {
      setErrors(
        mapIssuesToFieldErrors(parsed.error.issues, {
          effectiveFrom: 'effectiveFrom',
          amount: 'amount',
        }),
      );
      return;
    }
    mutation.mutate(payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resize {host.name}</DialogTitle>
          <DialogDescription>
            Appends a new capacity row; the previous row stays in the timeline.
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
            label="New capacity (GB)"
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
