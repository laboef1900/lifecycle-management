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
import { api, describeApiError, type ItemUpdateInputWire } from '@/lib/api-client';
import { todayIso } from '@/lib/format';

import { useItemMutations, type WithItemProps } from './shared';

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
