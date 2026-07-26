import { capacityRowInputSchema } from '@lcm/shared';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Field, useFocusFirstInvalidField } from '@/components/form/field';
import { REQUIRED_AMOUNT_MESSAGE, parseRequiredAmount } from '@/components/form/required-amount';
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
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalidField(formRef, errors);

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
    const parsedAmount = parseRequiredAmount(amount);
    const payload: CapacityAppendInputWire = {
      metricTypeKey: latest?.metricTypeKey ?? 'memory_gb',
      effectiveFrom,
      amount: parsedAmount,
    };
    const parsed = capacityRowInputSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors = mapIssuesToFieldErrors(parsed.error.issues, {
        effectiveFrom: 'effectiveFrom',
        amount: 'amount',
      });
      // A blank capacity arrives as NaN and is already rejected; this only swaps
      // Zod's "received NaN" for language an operator can act on. Getting here
      // with 0 would append a row that silently zeroes this host's contribution.
      if (Number.isNaN(parsedAmount)) fieldErrors.amount = REQUIRED_AMOUNT_MESSAGE;
      setErrors(fieldErrors);
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
        {/* noValidate: the browser's bubble fires before submit and would preempt the
            Field errors below — transient, unstyled, first-field-only, and invisible to
            a re-read. Safe because every `required` field here fails the parse too. */}
        <form ref={formRef} noValidate onSubmit={onSubmit} className="space-y-4">
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
