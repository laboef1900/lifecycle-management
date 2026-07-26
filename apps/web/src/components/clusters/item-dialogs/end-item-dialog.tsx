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
import { todayIso } from '@/lib/format';

import { useItemMutations, type WithItemProps } from './shared';

type FieldErrors = Partial<Record<'endedAt', string>>;

export function EndItemDialog({
  open,
  onOpenChange,
  clusterId,
  item,
}: WithItemProps): React.JSX.Element {
  const { invalidate } = useItemMutations(clusterId);
  const [endedAt, setEndedAt] = useState(item.endedAt ?? todayIso());
  const [errors, setErrors] = useState<FieldErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalidField(formRef, errors);

  const mutation = useMutation({
    mutationFn: (payload: ItemUpdateInputWire) => api.items.update(item.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success(item.endedAt ? 'Application updated' : 'Application ended');
      setErrors({});
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not end application')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    // The form is `noValidate`, so this is the only gate — a blank date must
    // never reach the mutation. The blank case gets the dialog's own words
    // because `dateOnly`'s "Must be a YYYY-MM-DD date" describes a wire format,
    // not the thing the operator forgot to do.
    if (endedAt.length === 0) {
      setErrors({ endedAt: 'Pick the date this allocation stops contributing.' });
      return;
    }
    const payload: ItemUpdateInputWire = { endedAt };
    const parsed = itemUpdateInputSchema.safeParse(payload);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'endedAt') next.endedAt = issue.message;
      }
      setErrors(next);
      // A schema-level issue with no field to point at (the "at least one field"
      // refine) would otherwise fail silently.
      if (next.endedAt === undefined) {
        toast.error(parsed.error.issues[0]?.message ?? 'Invalid input');
      }
      return;
    }
    mutation.mutate(payload);
  };

  // Clearing needs no date, so it needs no validation — but it must not leave a
  // stale error pointing at a field the operator is no longer being asked about.
  const onClear = (): void => {
    setErrors({});
    mutation.mutate({ endedAt: null });
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
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field
            label="Ended at"
            type="date"
            value={endedAt}
            onChange={(e) => setEndedAt(e.target.value)}
            error={errors.endedAt}
            required
          />
          <DialogFooter>
            {item.endedAt ? (
              <Button type="button" variant="ghost" onClick={onClear} disabled={mutation.isPending}>
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
